import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env";

export const connection = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null });
export const actionsQueue = new Queue("planned-actions", { connection, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 30000 }, removeOnComplete: 1000, removeOnFail: 5000 } });
export const webhooksQueue = new Queue("webhooks", { connection, defaultJobOptions: { attempts: 8, backoff: { type: "exponential", delay: 10000 } } });
