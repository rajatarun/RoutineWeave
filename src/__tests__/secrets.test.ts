const mockSend = jest.fn();

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("../config/environment", () => ({
  env: { AWS_REGION: "us-east-1", GEMINI_API_KEY: undefined },
}));

describe("getGeminiApiKey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it("returns key from Secrets Manager JSON", async () => {
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ key: "sm-api-key-123" }) });
    const { getGeminiApiKey } = await import("../config/secrets");
    const key = await getGeminiApiKey();
    expect(key).toBe("sm-api-key-123");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("throws when secret is missing the key field", async () => {
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ wrong: "field" }) });
    const { getGeminiApiKey } = await import("../config/secrets");
    await expect(getGeminiApiKey()).rejects.toThrow('"key" field');
  });

  it("throws when SecretString is empty", async () => {
    mockSend.mockResolvedValue({ SecretString: undefined });
    const { getGeminiApiKey } = await import("../config/secrets");
    await expect(getGeminiApiKey()).rejects.toThrow("no SecretString");
  });
});

describe("getGeminiApiKey (env fallback)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it("uses GEMINI_API_KEY env var without calling Secrets Manager", async () => {
    jest.mock("../config/environment", () => ({
      env: { AWS_REGION: "us-east-1", GEMINI_API_KEY: "local-key-from-env" },
    }));
    const { getGeminiApiKey } = await import("../config/secrets");
    const key = await getGeminiApiKey();
    expect(key).toBe("local-key-from-env");
    expect(mockSend).not.toHaveBeenCalled();
  });
});
