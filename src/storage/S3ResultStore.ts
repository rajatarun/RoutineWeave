import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/environment";
import { TaskExecutionResult } from "../scheduler/types";
import { logger } from "../utils";

const client = new S3Client({ region: env.AWS_REGION });

// Key structure: {task_name}/YYYY-MM-DD/{ISO-timestamp}.json
// e.g. ai_news_digest/2024-01-15/2024-01-15T08-00-00-000Z.json
function buildKey(taskName: string, timestamp: string): string {
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
    const key = buildKey(result.task_name, result.timestamp);
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
}
