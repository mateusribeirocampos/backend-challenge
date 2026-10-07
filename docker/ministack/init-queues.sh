#!/bin/sh
set -eu

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

# maxReceiveCount 10: permanent errors go to the DLQ by the consumer on the first delivery,
# so this limit only bounds transient retries. Kept high because a retry in a FIFO group
# also counts a receive for the messages behind it (see ARCHITECTURE.md).
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes '{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo\",\"maxReceiveCount\":\"10\"}"
}'

awslocal sqs create-queue --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
