variable "name" {
  description = "Name prefix."
  type        = string
}

variable "queues" {
  description = "Outbox topics and their queue settings."
  type = map(object({
    visibility_timeout_seconds = number
    max_receive_count          = number
  }))
  default = {
    "conversation-turns" = { visibility_timeout_seconds = 60, max_receive_count = 5 }
  }
}
