# One ECS Fargate service per runtime role (ADR-003): task definition, roles, logs,
# rolling deploys with circuit-breaker rollback, and auto-scaling. HTTP roles scale
# on CPU; queue workers on the age of the oldest SQS message (architecture §7).

data "aws_region" "current" {}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.cluster_name}/${var.role}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.cluster_name}-${var.role}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets" {
  count = length(var.secrets) > 0 ? 1 : 0
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    # Strip any ":json-key::" suffix to get the secret ARN itself.
    resources = distinct([for s in values(var.secrets) : join(":", slice(split(":", s), 0, 7))])
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(var.secrets) > 0 ? 1 : 0
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets[0].json
}

resource "aws_iam_role" "task" {
  name               = "${var.cluster_name}-${var.role}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "task" {
  count  = var.task_policy_json == null ? 0 : 1
  name   = "app"
  role   = aws_iam_role.task.id
  policy = var.task_policy_json
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.cluster_name}-${var.role}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = var.role
    image        = var.image
    essential    = true
    portMappings = [{ containerPort = var.port, protocol = "tcp" }]
    environment  = [for k, v in var.environment : { name = k, value = v }]
    secrets      = [for k, v in var.secrets : { name = k, valueFrom = v }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${var.port}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\""]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = var.role
      }
    }
    readonlyRootFilesystem = true
    user                   = "node"
  }])
}

resource "aws_ecs_service" "this" {
  name                               = var.role
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.min_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn == null ? [] : [var.target_group_arn]
    content {
      target_group_arn = load_balancer.value
      container_name   = var.role
      container_port   = var.port
    }
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.scale_on_queue_name == null ? 1 : 0
  name               = "${var.role}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "queue_age" {
  count              = var.scale_on_queue_name == null ? 0 : 1
  name               = "${var.role}-queue-age"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = var.queue_age_target_seconds
    customized_metric_specification {
      metric_name = "ApproximateAgeOfOldestMessage"
      namespace   = "AWS/SQS"
      statistic   = "Maximum"
      dimensions {
        name  = "QueueName"
        value = var.scale_on_queue_name
      }
    }
  }
}
