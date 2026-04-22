import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { env } from "../config/environment";
import { TaskExecutionResult } from "../scheduler/types";
import { logger } from "../utils";

const client = new S3Client({ region: env.AWS_REGION });

export interface ResultMeta {
  key: string;
  task_name: string;
  date: string;
  timestamp: string;
  size_bytes: number;
}

// Key structure: {task_name}/YYYY-MM-DD/{ISO-safe-timestamp}.json
// e.g. ai_news_digest/2024-01-15/2024-01-15T08-00-00-000Z.json
export function buildResultKey(taskName: string, timestamp: string): string {
  const date = timestamp.slice(0, 10);
  const safe = timestamp.replace(/:/g, "-").replace(/\./g, "-");
  return `${taskName}/${date}/${safe}.json`;
}

export class S3ResultStore {
  private bucket: string;

  constructor(bucket?: string) {
    const resolved = bucket ?? env.RESULTS_BUCKET;
    if (!resolved) throw new Error("RESULTS_BUCKET is not configured");
    this.bucket = resolved;
  }

  async save(result: TaskExecutionResult): Promise<void> {
    const key = buildResultKey(result.task_name, result.timestamp);
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(result, null, 2),
        ContentType: "application/json",
      })
    );
    logger.info("Result saved to S3", { bucket: this.bucket, key });
  }

  // List results for a task, optionally filtered by date (YYYY-MM-DD).
  async list(taskName: string, date?: string): Promise<ResultMeta[]> {
    const prefix = date ? `${taskName}/${date}/` : `${taskName}/`;
    const results: ResultMeta[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      for (const obj of response.Contents ?? []) {
        if (!obj.Key?.endsWith(".json") || !obj.LastModified) continue;
        const parts = obj.Key.split("/");
        results.push({
          key: obj.Key,
          task_name: taskName,
          date: parts[1] ?? "",
          timestamp: obj.LastModified.toISOString(),
          size_bytes: obj.Size ?? 0,
        });
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return results;
  }

  // Fetch the full result body by its S3 key.
  async getByKey(key: string): Promise<TaskExecutionResult | null> {
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      const body = await response.Body?.transformToString("utf-8");
      if (!body) return null;
      return JSON.parse(body) as TaskExecutionResult;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }
}
