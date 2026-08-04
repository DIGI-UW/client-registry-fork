FROM node:18-slim

RUN mkdir -p /var/log
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends git wget ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENV DOCKERIZE_VERSION v0.5.0
RUN wget https://github.com/jwilder/dockerize/releases/download/$DOCKERIZE_VERSION/dockerize-linux-amd64-$DOCKERIZE_VERSION.tar.gz \
    && tar -C /usr/local/bin -xzvf dockerize-linux-amd64-$DOCKERIZE_VERSION.tar.gz \
    && rm dockerize-linux-amd64-$DOCKERIZE_VERSION.tar.gz

# Build from the checked-out working tree (build context = repo root), NOT a fresh git clone: the
# clone ran inside a cacheable RUN layer, so registry-cached builds silently shipped stale code
# (frozen at whenever the layer was first built), and the :develop tag carried main's code because
# the branch build-arg was never passed. COPY invalidates the cache exactly when the code changes.
COPY . /src/

WORKDIR /src/server
RUN npm install

RUN cp /src/server/config/config_docker_template.json /src/server/config/config_docker.json
RUN cp /src/server/config/config_cicd_template.json /src/server/config/config_cicd.json

ARG NODE_ENV=docker
ENV NODE_ENV=$NODE_ENV

EXPOSE 3000

ARG DEFAULT_HAPI_FHIR_URL=http://fhir:8080/fhir/metadata
ENV HAPI_FHIR_URL=$DEFAULT_HAPI_FHIR_URL

ENTRYPOINT dockerize -wait-retry-interval 5s -timeout 60s -wait $HAPI_FHIR_URL node lib/app.js
