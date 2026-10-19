# NAT instance for the launch profile (ADR-023 cut C1): fck-nat on t4g.nano in an Auto
# Scaling group of one, so a failed instance replaces itself. The route tables point
# at a fixed network interface that each new instance attaches at boot, so routes and
# the public IP survive a replacement. The instance is rebuilt from the latest AMI on
# every refresh (NFR-06, NFR-15).

locals {
  nat_instance = var.nat_mode == "instance" ? 1 : 0
}

data "aws_ami" "fck_nat" {
  count       = local.nat_instance
  most_recent = true
  owners      = ["568608671756"] # fck-nat publisher
  filter {
    name   = "name"
    values = ["fck-nat-al2023-*-arm64-ebs"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_security_group" "nat" {
  count       = local.nat_instance
  name        = "${var.name}-nat"
  description = "NAT instance: forwards traffic from the app subnets"
  vpc_id      = aws_vpc.this.id
  ingress {
    description = "All traffic from the app subnets"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = aws_subnet.app[*].cidr_block
  }
  egress {
    description = "Out to the internet"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_network_interface" "nat" {
  count             = local.nat_instance
  subnet_id         = aws_subnet.public[0].id
  security_groups   = [aws_security_group.nat[0].id]
  source_dest_check = false
  tags              = { Name = "${var.name}-nat" }
}

resource "aws_eip" "nat_instance" {
  count             = local.nat_instance
  domain            = "vpc"
  network_interface = aws_network_interface.nat[0].id
  tags              = { Name = "${var.name}-nat" }
}

data "aws_iam_policy_document" "nat_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "nat" {
  count              = local.nat_instance
  name               = "${var.name}-nat"
  assume_role_policy = data.aws_iam_policy_document.nat_assume.json
}

data "aws_iam_policy_document" "nat" {
  statement {
    actions   = ["ec2:AttachNetworkInterface", "ec2:ModifyNetworkInterfaceAttribute"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "nat" {
  count  = local.nat_instance
  name   = "attach-eni"
  role   = aws_iam_role.nat[0].id
  policy = data.aws_iam_policy_document.nat.json
}

resource "aws_iam_role_policy_attachment" "nat_ssm" {
  count      = local.nat_instance
  role       = aws_iam_role.nat[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nat" {
  count = local.nat_instance
  name  = "${var.name}-nat"
  role  = aws_iam_role.nat[0].name
}

resource "aws_launch_template" "nat" {
  count         = local.nat_instance
  name_prefix   = "${var.name}-nat-"
  image_id      = data.aws_ami.fck_nat[0].id
  instance_type = var.nat_instance_type
  iam_instance_profile {
    arn = aws_iam_instance_profile.nat[0].arn
  }
  network_interfaces {
    subnet_id                   = aws_subnet.public[0].id
    security_groups             = [aws_security_group.nat[0].id]
    associate_public_ip_address = true
  }
  metadata_options {
    http_tokens = "required"
  }
  # fck-nat attaches this interface at boot and routes through it.
  user_data = base64encode(<<-EOT
    #!/bin/sh
    echo "eni_id=${aws_network_interface.nat[0].id}" >> /etc/fck-nat.conf
    service fck-nat restart
  EOT
  )
  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-nat" }
  }
}

resource "aws_autoscaling_group" "nat" {
  count               = local.nat_instance
  name                = "${var.name}-nat"
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1
  vpc_zone_identifier = [aws_subnet.public[0].id]
  health_check_type   = "EC2"
  launch_template {
    id      = aws_launch_template.nat[0].id
    version = aws_launch_template.nat[0].latest_version
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 0
    }
  }
  tag {
    key                 = "Name"
    value               = "${var.name}-nat"
    propagate_at_launch = true
  }
}
