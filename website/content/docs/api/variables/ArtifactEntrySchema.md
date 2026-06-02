---
title: "ArtifactEntrySchema"
---

```ts
const ArtifactEntrySchema: ZodObject<{
  bytes: ZodNumber;
  path: ZodString;
  type: ZodEnum<{
     directory: "directory";
     file: "file";
  }>;
}, $strip>;
```

Defined in: [src/schemas.ts:95](https://github.com/enixCode/light-run/blob/main/src/schemas.ts#L95)
