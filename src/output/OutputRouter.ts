import { OutputConfig, TaskExecutionResult } from "../scheduler/types";
import { OutputHandler, OutputPayload, buildPayload } from "./interfaces";
import { SNSPublisher } from "./SNSPublisher";
import { logger } from "../utils";

export class OutputRouter {
  private handlers = new Map<string, OutputHandler>();

  constructor() {
    this.registerHandler(new SNSPublisher());
  }

  registerHandler(handler: OutputHandler): void {
    this.handlers.set(handler.name, handler);
    logger.debug(`Registered output handler: ${handler.name}`);
  }

  async route(result: TaskExecutionResult, outputConfig: OutputConfig): Promise<void> {
    const handler = this.handlers.get(outputConfig.type);

    if (!handler) {
      logger.error(`No handler registered for output type: ${outputConfig.type}`);
      throw new Error(`Unsupported output type: ${outputConfig.type}`);
    }

    const payload: OutputPayload = buildPayload(result);

    logger.info(`Routing output via ${outputConfig.type}`, { task: result.task_name });

    await handler.publish(payload, outputConfig as unknown as Record<string, unknown>);
  }
}
