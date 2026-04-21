import {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  DeleteRuleCommand,
  RemoveTargetsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-eventbridge";
import { TaskDefinition } from "../scheduler/types";
import { env } from "../config";
import { logger } from "../utils";

const RULE_PREFIX = "routineweave-task-";
const TARGET_ID = "SchedulerLambda";

export class EventBridgeManager {
  private client: EventBridgeClient;
  private schedulerLambdaArn: string;

  constructor() {
    if (!env.SCHEDULER_LAMBDA_ARN) {
      throw new Error("SCHEDULER_LAMBDA_ARN environment variable is required for EventBridgeManager");
    }
    this.client = new EventBridgeClient({ region: env.AWS_REGION });
    this.schedulerLambdaArn = env.SCHEDULER_LAMBDA_ARN;
  }

  ruleName(taskName: string): string {
    return `${RULE_PREFIX}${taskName}`;
  }

  /**
   * Converts a standard 5-field cron to EventBridge 6-field cron format.
   *
   * EventBridge rules:
   *  - Format: cron(min hour dom month dow year)
   *  - dom and dow cannot BOTH be non-wildcard; one must be '?'
   *  - If both are '*', convention is dom='*' dow='?'
   */
  toEventBridgeCron(schedule: string): string {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Expected 5-field cron expression, got: "${schedule}"`);
    }

    const [min, hour, dom, month, dow] = parts;

    let ebDom = dom;
    let ebDow = dow;

    if (dom !== "*" && dow !== "*") {
      // Both specified — not valid in standard cron but handle gracefully
      ebDow = "?";
    } else if (dom === "*" && dow !== "*") {
      ebDom = "?";
    } else if (dom !== "*" && dow === "*") {
      ebDow = "?";
    } else {
      // Both '*' — every day; EventBridge requires one to be '?'
      ebDow = "?";
    }

    return `cron(${min} ${hour} ${ebDom} ${month} ${ebDow} *)`;
  }

  async upsertRule(task: TaskDefinition): Promise<void> {
    const name = this.ruleName(task.task_name);
    const scheduleExpression = this.toEventBridgeCron(task.schedule);
    const state = task.enabled ? "ENABLED" : "DISABLED";

    await this.client.send(
      new PutRuleCommand({
        Name: name,
        ScheduleExpression: scheduleExpression,
        State: state,
        Description: `RoutineWeave scheduled task: ${task.task_name}`,
      }),
    );

    await this.client.send(
      new PutTargetsCommand({
        Rule: name,
        Targets: [
          {
            Id: TARGET_ID,
            Arn: this.schedulerLambdaArn,
            Input: JSON.stringify({
              source: "routineweave",
              "detail-type": "Scheduled Task",
              detail: { task_name: task.task_name },
            }),
          },
        ],
      }),
    );

    logger.info(`EventBridge rule upserted: ${name}`, {
      scheduleExpression,
      state,
      task: task.task_name,
    });
  }

  async deleteRule(taskName: string): Promise<void> {
    const name = this.ruleName(taskName);

    try {
      await this.client.send(
        new RemoveTargetsCommand({ Rule: name, Ids: [TARGET_ID] }),
      );
      await this.client.send(new DeleteRuleCommand({ Name: name }));
      logger.info(`EventBridge rule deleted: ${name}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        logger.warn(`EventBridge rule not found, skipping delete: ${name}`);
        return;
      }
      throw error;
    }
  }
}
