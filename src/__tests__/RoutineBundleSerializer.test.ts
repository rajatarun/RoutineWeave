import {
  exportRoutineBundle,
  importRoutineBundle,
  RoutineDefinition,
} from "../engine/RoutineBundleSerializer";
import { WebhookPolicyError, WebhookPolicyGuard } from "../engine/WebhookPolicyGuard";

describe("RoutineBundleSerializer", () => {
  const sampleRoutines: RoutineDefinition[] = [
    {
      task_name: "morning_briefing",
      schedule: "0 7 * * *",
      enabled: true,
      hmacSecret: "super-secret-hmac-key",
      authToken: "bearer-secret-token",
      apiKey: "sk-live-secret-key",
      output: {
        type: "webhook",
        url: "https://hooks.example.com/briefing",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer top-secret-header",
        },
      },
      flowTrigger: {
        endpointUrl: "http://127.0.0.1:8787/v1/flows/run",
        flowId: "daily_briefing",
        hmacSecret: "nested-hmac-secret",
      },
    },
  ];

  it("exports portable bundle with SHA-256 checksum and strips all secret fields", () => {
    const bundle = exportRoutineBundle(sampleRoutines, { nodeId: "pi-home-01" });

    expect(bundle.schema).toBe("routine-bundle-v1");
    expect(bundle.node_id).toBe("pi-home-01");
    expect(bundle.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.routines).toHaveLength(1);

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("super-secret-hmac-key");
    expect(serialized).not.toContain("bearer-secret-token");
    expect(serialized).not.toContain("sk-live-secret-key");
    expect(serialized).not.toContain("top-secret-header");
    expect(serialized).not.toContain("nested-hmac-secret");

    expect(bundle.routines[0].hmacSecret).toBeUndefined();
    expect(bundle.routines[0].authToken).toBeUndefined();
    expect(bundle.routines[0].apiKey).toBeUndefined();
    expect(bundle.routines[0].output?.headers?.["Content-Type"]).toBe("application/json");
    expect(bundle.routines[0].output?.headers?.Authorization).toBeUndefined();
  });

  it("imports a valid bundle after verifying checksum and webhook URLs", () => {
    const bundle = exportRoutineBundle(sampleRoutines, { nodeId: "pi-home-01" });
    const imported = importRoutineBundle(bundle, new WebhookPolicyGuard());

    expect(imported).toHaveLength(1);
    expect(imported[0].task_name).toBe("morning_briefing");
    expect(imported[0].output?.url).toBe("https://hooks.example.com/briefing");
  });

  it("rejects tampered bundles fail-closed on checksum mismatch", () => {
    const bundle = exportRoutineBundle(sampleRoutines);
    bundle.routines[0].schedule = "*/1 * * * *";

    expect(() => importRoutineBundle(bundle)).toThrow(/checksum mismatch/i);
  });

  it("rejects routines containing SSRF-violating webhook URLs during import", () => {
    const ssrfRoutine: RoutineDefinition[] = [
      {
        task_name: "evil_metadata_probe",
        schedule: "0 * * * *",
        output: {
          type: "webhook",
          url: "http://[::ffff:169.254.169.254]/latest/meta-data/",
        },
      },
    ];
    const bundle = exportRoutineBundle(ssrfRoutine);

    expect(() => importRoutineBundle(bundle, new WebhookPolicyGuard())).toThrow(WebhookPolicyError);
  });

  it("enforces custom WebhookPolicyGuard allowedHosts on import", () => {
    const bundle = exportRoutineBundle([
      {
        task_name: "external_hook",
        schedule: "0 9 * * *",
        webhookUrl: "https://untrusted.example.org/hook",
      },
    ]);

    const strictGuard = new WebhookPolicyGuard({ allowedHosts: ["hooks.trusted.io"] });
    expect(() => importRoutineBundle(bundle, strictGuard)).toThrow(WebhookPolicyError);
  });
});
