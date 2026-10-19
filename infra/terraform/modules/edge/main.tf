# CloudFront + WAF in front of the ALB and the static bucket (ADR-003, architecture §7).
# Static builds (widget, dashboard, operator) come from S3 through OAC. /api, /widget
# and /ws go to the ALB uncached, over HTTPS to the origin name on the ALB's
# certificate. The ALB only accepts CloudFront's addresses and its secret header.

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "ALB, reachable only from CloudFront"
  vpc_id      = var.vpc_id
  ingress {
    description     = "From CloudFront origin-facing addresses"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    description = "To the ECS tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = var.app_subnet_cidrs
  }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  for_each                     = toset([for p in values(var.http_ports) : tostring(p)])
  security_group_id            = var.tasks_security_group_id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  ip_protocol                  = "tcp"
  description                  = "From the ALB"
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 3600 # long-lived SSE and WebSocket connections (ADR-017)
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
}

resource "aws_lb_target_group" "role" {
  for_each    = var.http_ports
  name        = "${var.name}-${each.key}"
  port        = each.value
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/readyz"
    matcher = "200"
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "this" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "realtime" {
  listener_arn = aws_lb_listener.this.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.role["realtime"].arn
  }
  condition {
    path_pattern {
      values = ["/ws", "/widget/v1/conversations/*/stream"]
    }
  }
  condition {
    http_header {
      http_header_name = "x-origin-verify"
      values           = [random_password.origin_verify.result]
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.this.arn
  priority     = 20
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.role["api"].arn
  }
  condition {
    path_pattern {
      values = ["/api/*", "/widget/v1/*", "/healthz", "/readyz"]
    }
  }
  condition {
    http_header {
      http_header_name = "x-origin-verify"
      values           = [random_password.origin_verify.result]
    }
  }
}

resource "aws_wafv2_web_acl" "this" {
  provider = aws.us_east_1
  name     = var.name
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }
  rule {
    name     = "aws-common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "aws-ip-reputation"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }
  # The basic rate rule until FEAT-071 adds per-route limits. Bot Control is deferred
  # in the launch profile until abuse appears (ADR-023 C4).
  rule {
    name     = "rate-per-ip"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5_min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudfront_origin_access_control" "static" {
  name                              = "${var.name}-static"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = var.name
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  web_acl_id          = aws_wafv2_web_acl.this.arn
  http_version        = "http2and3"
  aliases             = var.domain_names

  origin {
    origin_id                = "static"
    domain_name              = var.static_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.static.id
  }

  origin {
    origin_id   = "alb"
    domain_name = var.origin_domain_name
    custom_header {
      name  = "x-origin-verify"
      value = random_password.origin_verify.result
    }
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = ["/api/*", "/widget/v1/*", "/ws"]
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "alb"
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
      compress                 = false
    }
  }

  default_cache_behavior {
    target_origin_id       = "static"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.cloudfront_certificate_arn == null
    acm_certificate_arn            = var.cloudfront_certificate_arn
    ssl_support_method             = var.cloudfront_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.cloudfront_certificate_arn == null ? "TLSv1" : "TLSv1.2_2021"
  }
}

data "aws_iam_policy_document" "static" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.static_bucket_arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "static" {
  bucket = var.static_bucket_name
  policy = data.aws_iam_policy_document.static.json
}
