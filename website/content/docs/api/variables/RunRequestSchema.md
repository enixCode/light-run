---
title: "RunRequestSchema"
---

```ts
const RunRequestSchema: ZodObject<{
  callbackSecret: ZodOptional<ZodString>;
  callbackUrl: ZodOptional<ZodString>;
  detached: ZodOptional<ZodBoolean>;
  entrypoint: ZodOptional<ZodString>;
  env: ZodOptional<ZodRecord<ZodString, ZodString>>;
  extract: ZodOptional<ZodArray<ZodString>>;
  files: ZodRecord<ZodString, ZodString>;
  image: ZodString;
  input: ZodOptional<ZodUnknown>;
  networks: ZodOptional<ZodArray<ZodString>>;
  run: ZodOptional<ZodArray<ZodString>>;
  timeout: ZodOptional<ZodNumber>;
  workdir: ZodOptional<ZodString>;
}, $strip>;
```

Defined in: [src/schemas.ts:11](https://github.com/enixCode/light-run/blob/main/src/schemas.ts#L11)
