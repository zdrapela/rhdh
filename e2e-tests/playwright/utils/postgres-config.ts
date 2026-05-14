/**
 * PostgreSQL configuration utilities for external database tests.
 * Provides functions to configure TLS certificates and database credentials
 * via Kubernetes secrets for testing with external PostgreSQL instances
 * (Azure Database for PostgreSQL, Amazon RDS, etc.).
 *
 * Certificates are loaded from file paths set by CI pipeline (from Vault).
 * File paths are used instead of loading content into env vars to avoid
 * "Argument list too long" shell errors with large certificate bundles.
 * Each test file can import and apply its required configuration.
 */

import { readFileSync, existsSync } from "fs";
import * as yaml from "js-yaml";
import { Client } from "pg";
import * as k8s from "@kubernetes/client-node";
import { KubeClient } from "./kube-client";

/**
 * Convert escaped newlines (\n) to actual newline characters.
 * Environment variables from Vault often have literal \n instead of newlines.
 */
function unescapeNewlines(value: string): string {
  return value.replace(/\\n/g, "\n");
}

/**
 * Read certificate content from a file path.
 * @param filePath - Path to the certificate file
 * @returns Certificate content with escaped newlines converted, or null if file doesn't exist
 */
export function readCertificateFile(
  filePath: string | undefined,
): string | null {
  if (!filePath) {
    return null;
  }
  if (!existsSync(filePath)) {
    console.warn(`Certificate file not found: ${filePath}`);
    return null;
  }
  const content = readFileSync(filePath, "utf-8");
  return unescapeNewlines(content);
}

/**
 * Configure the postgres-crt secret with certificate content
 */
export async function configurePostgresCertificate(
  kubeClient: KubeClient,
  namespace: string,
  pemContent: string,
): Promise<void> {
  const certBase64 = Buffer.from(pemContent).toString("base64");
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "postgres-crt" },
    data: { "postgres-crt.pem": certBase64 },
  };
  await kubeClient.createOrUpdateSecret(secret, namespace);
}

/**
 * Configure the postgres-cred secret with database credentials
 */
export async function configurePostgresCredentials(
  kubeClient: KubeClient,
  namespace: string,
  credentials: {
    host: string;
    port?: string;
    user: string;
    password: string;
    database?: string;
    sslMode?: string;
  },
): Promise<void> {
  const data: Record<string, string> = {
    POSTGRES_HOST: Buffer.from(credentials.host).toString("base64"),
    POSTGRES_PORT: Buffer.from(credentials.port || "5432").toString("base64"),
    PGSSLMODE: Buffer.from(credentials.sslMode || "require").toString("base64"),
    NODE_EXTRA_CA_CERTS: Buffer.from(
      "/opt/app-root/src/postgres-crt.pem",
    ).toString("base64"),
  };

  if (credentials.user) {
    data.POSTGRES_USER = Buffer.from(credentials.user).toString("base64");
  }
  if (credentials.password) {
    data.POSTGRES_PASSWORD = Buffer.from(credentials.password).toString(
      "base64",
    );
  }
  if (credentials.database) {
    data.POSTGRES_DB = Buffer.from(credentials.database).toString("base64");
  }

  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "postgres-cred" },
    data,
  };
  await kubeClient.createOrUpdateSecret(secret, namespace);
}

/**
 * Clear all non-system databases from a PostgreSQL instance.
 * Used to clean up after external database tests.
 *
 * @param credentials - Database connection credentials
 * @param credentials.host - PostgreSQL host
 * @param credentials.port - PostgreSQL port (default: "5432")
 * @param credentials.user - PostgreSQL user
 * @param credentials.password - PostgreSQL password
 * @param certificatePath - Optional path to TLS certificate file
 */
export async function clearDatabase(credentials: {
  host: string;
  port?: string;
  user: string;
  password: string;
  certificatePath?: string;
}): Promise<void> {
  console.log("Starting database cleanup process...");

  // System databases that should never be dropped (includes cloud provider managed databases)
  const systemDatabases = [
    "postgres",
    "template0",
    "template1",
    // AWS RDS system databases
    "rdsadmin",
    // Azure Database for PostgreSQL system databases
    "azure_maintenance",
    "azure_sys",
  ];

  // Read certificate if path is provided
  let ssl: { ca: string } | boolean = true;
  if (credentials.certificatePath) {
    const certContent = readCertificateFile(credentials.certificatePath);
    if (certContent) {
      ssl = { ca: certContent };
    }
  }

  const client = new Client({
    host: credentials.host,
    port: parseInt(credentials.port || "5432"),
    user: credentials.user,
    password: credentials.password,
    database: "postgres",
    ssl,
    connectionTimeoutMillis: 30 * 1000,
    query_timeout: 120 * 1000,
  });

  try {
    await client.connect();

    // Get list of databases
    const result = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datistemplate = false",
    );

    const databases = result.rows
      .map((row) => row.datname)
      .filter((db) => !systemDatabases.includes(db));

    if (databases.length === 0) {
      console.log("No databases found to drop");
      return;
    }

    console.log(`Found databases to drop: ${databases.join(", ")}`);

    const succeeded: string[] = [];
    const failed: string[] = [];

    // Execute drops sequentially
    for (const db of databases) {
      let success = false;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // WITH (FORCE) atomically terminates connections and drops the database
          await client.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
          success = true;
          break;
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          const isRetryable =
            errorMsg.includes("being accessed by other users") ||
            errorMsg.includes("in use") ||
            errorMsg.includes("timeout");

          if (isRetryable && attempt < maxRetries) {
            const delay = attempt * 1000; // 1s, 2s, 3s
            console.log(
              `Retry ${attempt}/${maxRetries} for database ${db} after ${delay}ms (${errorMsg})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            console.warn(`Warning: Failed to drop database ${db}:`, errorMsg);
            break;
          }
        }
      }

      if (success) {
        succeeded.push(db);
      } else {
        failed.push(db);
      }
    }

    console.log(
      `Database cleanup completed: ${succeeded.length} dropped, ${failed.length} failed`,
    );
    if (succeeded.length > 0) {
      console.log(`Successfully dropped: ${succeeded.join(", ")}`);
    }
    if (failed.length > 0) {
      console.log(`Failed to drop: ${failed.join(", ")}`);
    }
  } catch (error) {
    console.error(
      "Failed to connect to database or retrieve database list:",
      error,
    );
    throw error;
  } finally {
    await client.end();
  }
}

interface AppConfigYaml {
  backend?: {
    database?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Prepare the RHDH deployment for external database tests.
 *
 * The runtime deployment starts with an internal (operator-managed or Helm sub-chart)
 * PostgreSQL. This function switches the configuration to use an external database by:
 *
 * 1. Removing any stale POSTGRES_* env var patches left by schema-mode tests
 * 2. Patching the app-config ConfigMap to add backend.database.connection with
 *    env var placeholders (${POSTGRES_HOST}, etc.) so that the postgres-cred
 *    secret values are used for the DB connection
 *
 * After calling this function, the test should:
 * - Call configurePostgresCertificate() to set the TLS cert
 * - Call configurePostgresCredentials() with real external DB credentials
 * - Call kubeClient.restartDeployment() to apply the changes
 *
 * @param kubeClient - KubeClient instance
 * @param namespace - Kubernetes namespace
 * @param deploymentName - Name of the RHDH deployment
 */
export async function prepareForExternalDatabase(
  kubeClient: KubeClient,
  namespace: string,
  deploymentName: string,
): Promise<void> {
  // --- 1. Remove stale POSTGRES_* env vars patched onto the deployment ---
  // Schema-mode tests may have added individual secretKeyRef env vars pointing
  // to a *-postgresql secret. These override the bulk envFrom injection from
  // postgres-cred and must be removed before external DB tests.
  await removeSchemaModePatchedEnvVars(kubeClient, deploymentName, namespace);

  // --- 2. Patch app-config ConfigMap to use external DB connection ---
  const configMapName = await kubeClient.findAppConfigMap(namespace);
  const configMapResponse = await kubeClient.getConfigMap(
    configMapName,
    namespace,
  );
  const configMap = configMapResponse.body;
  const configKey = Object.keys(configMap.data || {}).find((key) =>
    key.includes("app-config"),
  );

  if (!configKey || !configMap.data) {
    throw new Error(
      `No app-config data key found in ConfigMap '${configMapName}'`,
    );
  }

  const appConfig = yaml.load(configMap.data[configKey]) as AppConfigYaml;

  console.log(
    "Patching app-config to use external database connection (env var placeholders)...",
  );
  appConfig.backend = appConfig.backend || {};
  appConfig.backend.database = {
    connection: {
      host: "${POSTGRES_HOST}",
      port: "${POSTGRES_PORT}",
      user: "${POSTGRES_USER}",
      password: "${POSTGRES_PASSWORD}",
    },
  };

  configMap.data[configKey] = yaml.dump(appConfig);
  delete configMap.metadata?.creationTimestamp;
  delete configMap.metadata?.resourceVersion;

  await kubeClient.coreV1Api.replaceNamespacedConfigMap(
    configMapName,
    namespace,
    configMap,
  );
  console.log("App-config patched for external database connection");

  // --- 3. Add POSTGRES_* env vars to the deployment via secretKeyRef ---
  // The deployment starts with internal DB (no postgres-cred env vars).
  // Add individual env vars pointing to the postgres-cred secret so the
  // app-config ${POSTGRES_HOST} etc. placeholders resolve correctly.
  await ensurePostgresCredEnvVars(kubeClient, deploymentName, namespace);
}

/**
 * Remove POSTGRES_* env vars from the deployment that were injected via secretKeyRef
 * by schema-mode tests (pointing to the *-postgresql secret). These override the
 * env vars injected by the operator/helm via extraEnvs/extraEnvVarsSecrets from postgres-cred.
 */
async function removeSchemaModePatchedEnvVars(
  kubeClient: KubeClient,
  deploymentName: string,
  namespace: string,
): Promise<void> {
  const response = await kubeClient.appsApi.readNamespacedDeployment(
    deploymentName,
    namespace,
  );
  const containers = response.body.spec?.template?.spec?.containers || [];
  const backstageIdx = containers.findIndex(
    (c) => c.name === "backstage-backend",
  );
  const backstageContainer = containers[backstageIdx];

  if (!backstageContainer?.env) {
    return;
  }

  // Find env vars that reference a *-postgresql secret (added by schema-mode)
  const schemaModeVars = [
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
  ];
  const indicesToRemove: number[] = [];

  backstageContainer.env.forEach((envVar: k8s.V1EnvVar, idx: number) => {
    if (
      schemaModeVars.includes(envVar.name) &&
      envVar.valueFrom?.secretKeyRef?.name?.endsWith("-postgresql")
    ) {
      indicesToRemove.push(idx);
    }
  });

  if (indicesToRemove.length === 0) {
    console.log("No schema-mode env var patches found on deployment");
    return;
  }

  console.log(
    `Removing ${indicesToRemove.length} schema-mode env var patches from deployment...`,
  );

  // Build JSON patch to remove indices in reverse order (so indices stay valid)
  const patch = indicesToRemove
    .sort((a, b) => b - a)
    .map((idx) => ({
      op: "remove" as const,
      path: `/spec/template/spec/containers/${backstageIdx}/env/${idx}`,
    }));

  await kubeClient.appsApi.patchNamespacedDeployment(
    deploymentName,
    namespace,
    patch,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { "Content-Type": "application/json-patch+json" } },
  );
  console.log("Schema-mode env var patches removed from deployment");
}

/**
 * Set POSTGRES_* env vars on the deployment via secretKeyRef from the postgres-cred secret.
 * Removes any existing env vars with the same names first (regardless of their source —
 * they may come from Helm chart templates, schema-mode patches, or other sources),
 * then adds fresh secretKeyRef entries pointing to the postgres-cred secret.
 * This ensures the app-config ${POSTGRES_HOST} etc. placeholders resolve from postgres-cred.
 */
async function ensurePostgresCredEnvVars(
  kubeClient: KubeClient,
  deploymentName: string,
  namespace: string,
): Promise<void> {
  const response = await kubeClient.appsApi.readNamespacedDeployment(
    deploymentName,
    namespace,
  );
  const containers = response.body.spec?.template?.spec?.containers || [];
  const backstageIdx = containers.findIndex(
    (c) => c.name === "backstage-backend",
  );

  if (backstageIdx === -1) {
    console.warn(
      "backstage-backend container not found, skipping env var injection",
    );
    return;
  }

  const backstageContainer = containers[backstageIdx];
  const existingEnv = backstageContainer.env || [];

  const requiredVars = [
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "PGSSLMODE",
    "NODE_EXTRA_CA_CERTS",
  ];

  // Remove existing env vars that we need to replace (in reverse index order)
  const indicesToRemove = existingEnv
    .map((e: k8s.V1EnvVar, idx: number) => ({ name: e.name, idx }))
    .filter((e: { name: string; idx: number }) => requiredVars.includes(e.name))
    .map((e: { name: string; idx: number }) => e.idx);

  const patch: object[] = [];

  if (indicesToRemove.length > 0) {
    console.log(
      `Removing ${indicesToRemove.length} existing POSTGRES_* env vars from deployment`,
    );
    // Remove in reverse order so indices stay valid
    for (const idx of indicesToRemove.sort((a: number, b: number) => b - a)) {
      patch.push({
        op: "remove",
        path: `/spec/template/spec/containers/${backstageIdx}/env/${idx}`,
      });
    }
  }

  // Add fresh env vars from postgres-cred secret
  console.log(
    `Adding ${requiredVars.length} env vars to deployment from postgres-cred secret`,
  );

  // If env array might be empty after removals, ensure it exists
  if (
    existingEnv.length === 0 ||
    existingEnv.length === indicesToRemove.length
  ) {
    patch.push({
      op: "add",
      path: `/spec/template/spec/containers/${backstageIdx}/env`,
      value: [],
    });
  }

  for (const varName of requiredVars) {
    patch.push({
      op: "add",
      path: `/spec/template/spec/containers/${backstageIdx}/env/-`,
      value: {
        name: varName,
        valueFrom: {
          secretKeyRef: {
            name: "postgres-cred",
            key: varName,
          },
        },
      },
    });
  }

  await kubeClient.appsApi.patchNamespacedDeployment(
    deploymentName,
    namespace,
    patch,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { "Content-Type": "application/json-patch+json" } },
  );
  console.log(
    "POSTGRES_* env vars set on deployment from postgres-cred secret",
  );
}
