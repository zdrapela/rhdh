#!/bin/sh

handle_gke() {
  log_info "Starting GKE deployment"
  for file in ${DIR}/cluster/gke/*.sh; do source $file; done

  gcloud_auth "${GKE_SERVICE_ACCOUNT_NAME}" "/tmp/secrets/GKE_SERVICE_ACCOUNT_KEY"
  gcloud_gke_get_credentials "${GKE_CLUSTER_NAME}" "${GKE_CLUSTER_REGION}" "${GOOGLE_CLOUD_PROJECT}"
  set_github_app_3_credentials
  export K8S_CLUSTER_ROUTER_BASE=$GKE_INSTANCE_DOMAIN_NAME
  url="https://${K8S_CLUSTER_ROUTER_BASE}"

  apply_yaml_files "${DIR}" "${NAME_SPACE}"

  initiate_gke_deployment
  check_and_test "${RELEASE_NAME}" "${NAME_SPACE_K8S}" "${url}"
  delete_namespace "${NAME_SPACE_K8S}"
  initiate_rbac_gke_deployment
  check_and_test "${RELEASE_NAME_RBAC}" "${NAME_SPACE_RBAC_K8S}"
  delete_namespace "${NAME_SPACE_RBAC_K8S}"

}
