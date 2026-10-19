# The ECS cluster, one ECR repository per runtime role, and the security group all
# tasks share (ADR-001, ADR-003). Images are scanned on push (NFR-15).

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_ecr_repository" "role" {
  for_each             = toset(var.roles)
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
  }
}

resource "aws_ecr_lifecycle_policy" "role" {
  for_each   = aws_ecr_repository.role
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "ECS tasks; ingress only from the ALB"
  vpc_id      = var.vpc_id
  egress {
    description = "Outbound to VPC endpoints, data stores and, through NAT, Bedrock and channel APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
