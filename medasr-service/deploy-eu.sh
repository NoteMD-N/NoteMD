#!/usr/bin/env bash
#
# Deploy the MedASR service to a European Cloud Run region.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The original service was deployed by hand to us-east4 (Northern Virginia)
# with its container image in us-central1 (Iowa). Both are US regions, which
# is incompatible with the UK/EU data residency requirement.
#
# A Cloud Run service's region is fixed at creation and cannot be changed, so
# this deploys a NEW service in Europe. MedASR is stateless — it loads a model
# and transcribes what it is sent, persisting nothing — so there is no data to
# migrate. Once the new service is verified, delete the US one (see the end).
#
# USAGE
#   ./deploy-eu.sh                 # deploy to europe-west2 (London)
#   REGION=europe-west1 ./deploy-eu.sh
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-notemd-489910}"
REGION="${REGION:-europe-west2}"          # London. europe-west1 = Belgium.
SERVICE="${SERVICE:-medasr-service}"
REPO="${REPO:-medasr-repo}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:${IMAGE_TAG}"

echo "==> Project : ${PROJECT_ID}"
echo "==> Region  : ${REGION}"
echo "==> Image   : ${IMAGE}"
echo

gcloud config set project "${PROJECT_ID}"

# ---------------------------------------------------------------------------
# 1. Artifact Registry repository in the target region.
#
# Repositories are regional too — pushing to the existing us-central1 repo
# would leave the image in the US even if the service runs in Europe.
# ---------------------------------------------------------------------------
if ! gcloud artifacts repositories describe "${REPO}" --location="${REGION}" >/dev/null 2>&1; then
  echo "==> Creating Artifact Registry repo ${REPO} in ${REGION}"
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="MedASR container images (EU)"
else
  echo "==> Artifact Registry repo ${REPO} already exists in ${REGION}"
fi

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ---------------------------------------------------------------------------
# 2. Build and push.
#
# Cloud Build runs in the region we pass, so the build itself stays in the EU.
# ---------------------------------------------------------------------------
echo "==> Building and pushing image"
gcloud builds submit \
  --region="${REGION}" \
  --tag="${IMAGE}" \
  .

# ---------------------------------------------------------------------------
# 3. Deploy the Cloud Run service.
#
# --no-allow-unauthenticated keeps it private; the Supabase edge function
# authenticates with a GCP identity token (see getGcpIdentityToken).
#
# Memory/CPU are sized for a transformers ASR pipeline. Cold starts load the
# model, hence the generous timeout. Set --min-instances=1 to avoid cold
# starts at the cost of always-on billing.
# ---------------------------------------------------------------------------
echo "==> Deploying Cloud Run service ${SERVICE} to ${REGION}"
gcloud run deploy "${SERVICE}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --no-allow-unauthenticated \
  --port=8080 \
  --memory=4Gi \
  --cpu=2 \
  --timeout=300 \
  --concurrency=4 \
  --min-instances=0 \
  --max-instances=5

SERVICE_URL="$(gcloud run services describe "${SERVICE}" --region="${REGION}" --format='value(status.url)')"

# ---------------------------------------------------------------------------
# 4. Re-grant invoker permission.
#
# IAM bindings do not carry over from the old service. The service account
# behind GCP_SERVICE_ACCOUNT_KEY in Supabase must be able to invoke this one.
# ---------------------------------------------------------------------------
if [[ -n "${INVOKER_SERVICE_ACCOUNT:-}" ]]; then
  echo "==> Granting run.invoker to ${INVOKER_SERVICE_ACCOUNT}"
  gcloud run services add-iam-policy-binding "${SERVICE}" \
    --region="${REGION}" \
    --member="serviceAccount:${INVOKER_SERVICE_ACCOUNT}" \
    --role="roles/run.invoker"
else
  echo
  echo "!! INVOKER_SERVICE_ACCOUNT not set — the edge function will get 403."
  echo "!! Find the client_email in the GCP_SERVICE_ACCOUNT_KEY Supabase secret, then run:"
  echo "!!   gcloud run services add-iam-policy-binding ${SERVICE} \\"
  echo "!!     --region=${REGION} \\"
  echo "!!     --member=serviceAccount:<client_email> \\"
  echo "!!     --role=roles/run.invoker"
fi

cat <<EOF

============================================================
Deployed to ${REGION}

  ${SERVICE_URL}

NEXT STEPS
  1. Update the Supabase secret so the edge functions use it:
       supabase secrets set MEDASR_URL="${SERVICE_URL}"

  2. Verify transcription works end to end (Settings -> Accurate engine,
     with TRANSCRIBE_ACCURATE_PROVIDER=medasr to force this path).

  3. Only once verified, delete the US resources:
       gcloud run services delete ${SERVICE} --region=us-east4
       gcloud artifacts repositories delete ${REPO} --location=us-central1

     Deleting the old Artifact Registry repo matters — the container image
     sitting in us-central1 is still US-resident storage.
============================================================
EOF
