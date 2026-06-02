---
title: "RunStateSchema"
---

```ts
const RunStateSchema: ZodObject<{
  artifacts: ZodOptional<ZodArray<ZodObject<{
     bytes: ZodNumber;
     path: ZodString;
     type: ZodEnum<{
        directory: "directory";
        file: "file";
     }>;
  }, $strip>>>;
  durationMs: ZodOptional<ZodNumber>;
  error: ZodOptional<ZodString>;
  exitCode: ZodOptional<ZodNumber>;
  finishedAt: ZodOptional<ZodString>;
  id: ZodString;
  logs: ZodOptional<ZodArray<ZodString>>;
  startedAt: ZodString;
  status: ZodEnum<{
     cancelled: "cancelled";
     failed: "failed";
     running: "running";
     succeeded: "succeeded";
  }>;
}, $strip>;
```

Defined in: [src/schemas.ts:105](https://github.com/enixCode/light-run/blob/main/src/schemas.ts#L105)
