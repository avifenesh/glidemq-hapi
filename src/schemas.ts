import Joi from 'joi';

// --- Reusable fragments ---

const removeOnSchema = Joi.alternatives().try(
  Joi.boolean(),
  Joi.number(),
  Joi.object({ age: Joi.number().required(), count: Joi.number().required() }),
);

const jobOptsSchema = Joi.object({
  delay: Joi.number(),
  priority: Joi.number().integer().min(0).max(2048),
  attempts: Joi.number(),
  timeout: Joi.number(),
  removeOnComplete: removeOnSchema,
  removeOnFail: removeOnSchema,
  jobId: Joi.string(),
  lifo: Joi.boolean(),
  deduplication: Joi.object({
    id: Joi.string().required(),
    ttl: Joi.number(),
    mode: Joi.string().valid('simple', 'throttle', 'debounce'),
  }),
  ordering: Joi.object({
    key: Joi.string().required(),
    concurrency: Joi.number(),
  }),
  cost: Joi.number(),
  backoff: Joi.object({
    type: Joi.string().required(),
    delay: Joi.number().required(),
    jitter: Joi.number(),
  }),
  parent: Joi.object({
    queue: Joi.string().required(),
    id: Joi.string().required(),
  }),
  ttl: Joi.number(),
}).default({});

// --- Param schemas ---

export const queueNameParamSchema = Joi.object({
  name: Joi.string().pattern(/^[a-zA-Z0-9_-]{1,128}$/).required(),
});

export const jobIdParamSchema = Joi.object({
  name: Joi.string().pattern(/^[a-zA-Z0-9_-]{1,128}$/).required(),
  id: Joi.string().required(),
});

export const schedulerParamSchema = Joi.object({
  name: Joi.string().pattern(/^[a-zA-Z0-9_-]{1,128}$/).required(),
  schedulerName: Joi.string().pattern(/^[a-zA-Z0-9_:.\-]{1,256}$/).required(),
});

// --- Body / payload schemas ---

export const addJobSchema = Joi.object({
  name: Joi.string().min(1).required(),
  data: Joi.any().default({}),
  opts: jobOptsSchema,
});

export const addAndWaitBodySchema = Joi.object({
  name: Joi.string().min(1).required(),
  data: Joi.any().default({}),
  opts: jobOptsSchema,
  waitTimeout: Joi.number().positive(),
});

export const changePriorityBodySchema = Joi.object({
  priority: Joi.number().integer().min(0).max(2048).required(),
});

export const changeDelayBodySchema = Joi.object({
  delay: Joi.number().integer().min(0).required(),
});

export const retryBodySchema = Joi.object({
  count: Joi.number().integer().min(1),
});

export const upsertSchedulerBodySchema = Joi.object({
  schedule: Joi.object({
    pattern: Joi.string(),
    every: Joi.number(),
    repeatAfterComplete: Joi.boolean(),
    tz: Joi.string(),
    startDate: Joi.alternatives().try(Joi.string(), Joi.number()),
    endDate: Joi.alternatives().try(Joi.string(), Joi.number()),
    limit: Joi.number(),
  }).required(),
  template: Joi.object({
    name: Joi.string(),
    data: Joi.any(),
    opts: Joi.object().unknown(true),
  }),
});

// --- Query schemas ---

export const getJobsQuerySchema = Joi.object({
  type: Joi.string()
    .valid('waiting', 'active', 'delayed', 'completed', 'failed')
    .default('waiting'),
  start: Joi.number().default(0),
  end: Joi.number().default(-1),
  excludeData: Joi.boolean().truthy('true', '1').falsy('false', '0').default(false),
});

export const cleanQuerySchema = Joi.object({
  grace: Joi.number().integer().min(0).default(0),
  limit: Joi.number().integer().min(1).default(100),
  type: Joi.string().valid('completed', 'failed').default('completed'),
});

export const metricsQuerySchema = Joi.object({
  type: Joi.string().valid('completed', 'failed').required(),
  start: Joi.number().default(0),
  end: Joi.number().default(-1),
});

// --- Plugin options schema ---

export const optionsSchema = Joi.object({
  connection: Joi.object().unknown(true),
  queues: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      processor: Joi.function(),
      concurrency: Joi.number().integer().min(1),
      workerOpts: Joi.object().unknown(true),
    }),
  ),
  producers: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      compression: Joi.string().valid('none', 'gzip'),
      serializer: Joi.object().unknown(true),
    }),
  ),
  prefix: Joi.string(),
  testing: Joi.boolean(),
  serializer: Joi.object().unknown(true),
  routes: Joi.alternatives().try(
    Joi.boolean(),
    Joi.object({
      queues: Joi.array().items(Joi.string()),
      producers: Joi.array().items(Joi.string()),
    }),
  ),
});
