# Deployment configuration (GitHub Actions)

RoutineWeave's production deploy workflow (`.github/workflows/deploy.yml`) expects the following GitHub **repository secrets** and **variables**. Use placeholder-style values when configuring your fork; never commit real account identifiers to the repository.

## Repository secrets

| Name | Purpose | Example placeholder |
|------|---------|---------------------|
| `AWS_DEPLOY_ROLE_ARN` | IAM role ARN assumed via GitHub OIDC for `sam deploy` | `arn:aws:iam::123456789012:role/example-deploy-role` |
| `SNS_NOTIFICATION_EMAIL` | Email subscribed to the RoutineWeave SNS topic (replaces a hardcoded address in the SAM template) | `you@example.com` |

## Repository variables

| Name | Purpose | Example placeholder |
|------|---------|---------------------|
| `AWS_REGION` | AWS region for deploy and shared-stack lookup (defaults to `us-east-1` in the workflow if unset) | `us-east-1` |
| `SHARED_OBSERVATORY_STACK_NAME` | CloudFormation stack that exports `ObservatoryMetricsTableName` and `ObservatoryMetricsTableArn` | `example-shared-observability` |

## SAM parameters (via workflow)

The deploy job passes these as `--parameter-overrides` (Observatory values come from the shared stack outputs):

| Parameter | Source |
|-----------|--------|
| `Environment` | Workflow input / default `production` |
| `LogLevel` | Fixed `info` in workflow |
| `ObservatoryMetricsTableName` | Output from `SHARED_OBSERVATORY_STACK_NAME` |
| `ObservatoryMetricsTableArn` | Output from `SHARED_OBSERVATORY_STACK_NAME` |
| `NotificationSubscriberEmail` | Secret `SNS_NOTIFICATION_EMAIL` |

## Local `sam deploy`

When deploying outside GitHub Actions, supply the same parameters explicitly:

```bash
sam deploy \
  --stack-name routineweave-production \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    Environment=production \
    LogLevel=info \
    ObservatoryMetricsTableName=example-shared-OBSERVATORY_METRICS \
    ObservatoryMetricsTableArn=arn:aws:dynamodb:us-east-1:123456789012:table/example-shared-OBSERVATORY_METRICS \
    NotificationSubscriberEmail=you@example.com
```

## Reference IAM policy snippet

`aws/iam-policy.json` shows least-privilege **resource ARNs** for the Lambda execution role with the example account id `123456789012`. Replace with your account id before attaching the policy in AWS.

## AWS Secrets Manager (not GitHub)

| Secret name in AWS | Purpose |
|--------------------|---------|
| `gemini/api_key` | JSON `{"key":"<your Gemini API key>"}` read by Lambda at runtime |
