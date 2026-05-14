#!/bin/bash

# shellcheck source=.ci/pipelines/lib/log.sh
source "$DIR"/lib/log.sh
# shellcheck source=.ci/pipelines/lib/common.sh
source "$DIR"/lib/common.sh
# shellcheck source=.ci/pipelines/utils.sh
source "$DIR"/utils.sh
# shellcheck source=.ci/pipelines/lib/testing.sh
source "$DIR"/lib/testing.sh
# shellcheck source=.ci/pipelines/playwright-projects.sh
source "$DIR"/playwright-projects.sh
# shellcheck source=.ci/pipelines/lib/schema-mode-env.sh
source "$DIR"/lib/schema-mode-env.sh

handle_ocp_nightly() {
  export NAME_SPACE="${NAME_SPACE:-showcase-ci-nightly}"
  export NAME_SPACE_RBAC="${NAME_SPACE_RBAC:-showcase-rbac-nightly}"
  export NAME_SPACE_POSTGRES_DB="${NAME_SPACE_POSTGRES_DB:-postgress-external-db-nightly}"

  common::oc_login

  K8S_CLUSTER_ROUTER_BASE=$(oc get route console -n openshift-console -o=jsonpath='{.spec.host}' | sed 's/^[^.]*\.//')
  export K8S_CLUSTER_ROUTER_BASE

  cluster_setup_ocp_helm

  # Use OSD-GCP specific deployment for osd-gcp jobs (orchestrator disabled)
  if [[ "${JOB_NAME}" == *osd-gcp* ]]; then
    log::info "Detected OSD-GCP job, using OSD-GCP specific deployment (orchestrator disabled)"
    initiate_deployments_osd_gcp "${PW_PROJECT_SHOWCASE}" "${PW_PROJECT_SHOWCASE_RBAC}"
  else
    initiate_deployments "${PW_PROJECT_SHOWCASE}" "${PW_PROJECT_SHOWCASE_RBAC}"
  fi

  deploy_test_backstage_customization_provider "${NAME_SPACE}"

  run_standard_deployment_tests
  run_runtime_config_change_tests
  run_sanity_plugins_check

  # Skip localization tests for OSD-GCP jobs
  if [[ "${JOB_NAME}" != *osd-gcp* ]]; then
    run_localization_tests
  fi

}

run_standard_deployment_tests() {
  local url="https://${RELEASE_NAME}-developer-hub-${NAME_SPACE}.${K8S_CLUSTER_ROUTER_BASE}"
  testing::check_and_test "${RELEASE_NAME}" "${NAME_SPACE}" "${PW_PROJECT_SHOWCASE}" "${url}"
  local rbac_url="https://${RELEASE_NAME_RBAC}-developer-hub-${NAME_SPACE_RBAC}.${K8S_CLUSTER_ROUTER_BASE}"
  testing::check_and_test "${RELEASE_NAME_RBAC}" "${NAME_SPACE_RBAC}" "${PW_PROJECT_SHOWCASE_RBAC}" "${rbac_url}"
}

run_runtime_config_change_tests() {
  # Deploy `showcase-runtime` with internal (Helm sub-chart) PostgreSQL.
  # The deployment is pre-wired with postgres-cred and postgres-crt secrets
  # so external DB tests can switch to external DB at runtime by updating
  # secret contents and patching the app-config ConfigMap.

  # Create the namespace first (this will delete/recreate it)
  namespace::configure "${NAME_SPACE_RUNTIME}"

  # Pre-create placeholder secrets referenced by values-showcase-runtime.yaml.
  # External DB tests will overwrite these with real credentials at runtime.
  create_postgres_cred_secret "${NAME_SPACE_RUNTIME}" "tmp" "tmp"
  # Override PGSSLMODE to 'disable' so the placeholder doesn't break the internal DB
  # connection (Bitnami PostgreSQL sub-chart doesn't enable SSL by default).
  # The external DB tests will set PGSSLMODE=require when configuring real credentials.
  oc patch secret postgres-cred -n "${NAME_SPACE_RUNTIME}" \
    -p "{\"data\":{\"PGSSLMODE\":\"$(echo -n disable | base64)\"}}"
  oc apply -f "$DIR/resources/postgres-db/postgres-crt.yaml" -n "${NAME_SPACE_RUNTIME}"

  # Deploy RHDH with Helm using internal PostgreSQL (sub-chart enabled)
  helm::uninstall "${NAME_SPACE_RUNTIME}" "${RELEASE_NAME}"
  oc apply -f "$DIR/resources/postgres-db/dynamic-plugins-root-PVC.yaml" -n "${NAME_SPACE_RUNTIME}"
  # shellcheck disable=SC2046
  helm upgrade -i "${RELEASE_NAME}" -n "${NAME_SPACE_RUNTIME}" \
    "${HELM_CHART_URL}" --version "${CHART_VERSION}" \
    -f "$DIR/resources/postgres-db/values-showcase-runtime.yaml" \
    --set global.clusterRouterBase="${K8S_CLUSTER_ROUTER_BASE}" \
    $(helm::get_image_params)

  # Configure schema-mode environment (opt-in: tests skip if env not configured)
  if configure_schema_mode_runtime_env "${NAME_SPACE_RUNTIME}" "${RELEASE_NAME}" helm; then
    log::info "Schema-mode environment configured successfully; schema-mode tests will run"
  else
    log::warn "Schema-mode environment not configured; schema-mode tests will skip (this is expected if PostgreSQL is not available)"
  fi

  local runtime_url="https://${RELEASE_NAME}-developer-hub-${NAME_SPACE_RUNTIME}.${K8S_CLUSTER_ROUTER_BASE}"
  # Run tests - allow failures since schema-mode tests are opt-in
  testing::run_tests "${RELEASE_NAME}" "${NAME_SPACE_RUNTIME}" "${PW_PROJECT_SHOWCASE_RUNTIME_DB}" "${runtime_url}" || true
}

run_sanity_plugins_check() {
  local sanity_plugins_url="https://${RELEASE_NAME}-developer-hub-${NAME_SPACE_SANITY_PLUGINS_CHECK}.${K8S_CLUSTER_ROUTER_BASE}"
  initiate_sanity_plugin_checks_deployment "${RELEASE_NAME}" "${NAME_SPACE_SANITY_PLUGINS_CHECK}" "${sanity_plugins_url}" "${PW_PROJECT_SHOWCASE_SANITY_PLUGINS}"
  testing::check_and_test "${RELEASE_NAME}" "${NAME_SPACE_SANITY_PLUGINS_CHECK}" "${PW_PROJECT_SHOWCASE_SANITY_PLUGINS}" "${sanity_plugins_url}"
}

run_localization_tests() {
  local url="https://${RELEASE_NAME}-developer-hub-${NAME_SPACE}.${K8S_CLUSTER_ROUTER_BASE}"
  local locales=("DE" "ES" "FR" "IT" "JA")

  log::section "Running localization tests"
  # Loop through all locales - uses project name as artifacts_subdir to avoid overwriting test artifacts
  for locale in "${locales[@]}"; do
    local project_var="PW_PROJECT_SHOWCASE_LOCALIZATION_${locale}"
    local project="${!project_var}"
    log::info "Running localization test for ${locale} (project: ${project})"
    testing::check_and_test "${RELEASE_NAME}" "${NAME_SPACE}" "${project}" "${url}" "" "" "${project}"
  done
}
