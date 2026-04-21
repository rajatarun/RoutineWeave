import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { TaskDefinition, TaskDefinitionSchema } from "../scheduler/types";
import { env } from "../config";
import { logger } from "../utils";

export class S3TaskStore {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(bucket?: string, prefix?: string) {
    const resolvedBucket = bucket ?? env.TASKS_BUCKET;
    if (!resolvedBucket) {
      throw new Error("TASKS_BUCKET environment variable is required for S3TaskStore");
    }
    this.client = new S3Client({ region: env.AWS_REGION });
    this.bucket = resolvedBucket;
    this.prefix = prefix ?? env.TASKS_S3_PREFIX;
  }

  private key(taskName: string): string {
    return `${this.prefix}${taskName}.json`;
  }

  private taskNameFromKey(key: string): string {
    return key.slice(this.prefix.length, -".json".length);
  }

  async list(): Promise<TaskDefinition[]> {
    const tasks: TaskDefinition[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (!obj.Key?.endsWith(".json")) continue;
        const taskName = this.taskNameFromKey(obj.Key);
        const task = await this.get(taskName);
        if (task) tasks.push(task);
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    logger.info(`Loaded ${tasks.length} task(s) from S3`, { bucket: this.bucket, prefix: this.prefix });
    return tasks;
  }

  async get(taskName: string): Promise<TaskDefinition | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(taskName) }),
      );
      const body = await response.Body?.transformToString("utf-8");
      if (!body) return null;

      const parsed = JSON.parse(body);
      const result = TaskDefinitionSchema.safeParse(parsed);
      if (!result.success) {
        logger.error(`Invalid task definition in S3: ${taskName}`, {
          errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
        });
        return null;
      }
      return result.data;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async put(task: TaskDefinition): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(task.task_name),
        Body: JSON.stringify(task, null, 2),
        ContentType: "application/json",
      }),
    );
    logger.info(`Task saved to S3: ${task.task_name}`, { bucket: this.bucket });
  }

  async delete(taskName: string): Promise<boolean> {
    const existing = await this.get(taskName);
    if (!existing) return false;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(taskName) }),
    );
    logger.info(`Task deleted from S3: ${taskName}`, { bucket: this.bucket });
    return true;
  }
}
