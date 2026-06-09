#################################################
# Common base image
#################################################
FROM node:14-alpine as common
RUN mkdir /app && chown node:node /app
WORKDIR /app
USER node

# Cache node_modules installation as they change
# less than code over time.
COPY package.json yarn.lock tsconfig.json ./
RUN yarn install --production && \
    rm -rf ~/.cache /tmp/v8-compile-cache-1000

#################################################
# Compile stage
#################################################
FROM common as build
RUN yarn install
COPY src/ src/
RUN yarn compile

#################################################
# Production stage
#################################################
FROM common
COPY views/ views/
# It's a toss up on which order offsets and src
# should be. Offsets are gauranteed to change
# over time, but src has more changes in `git log`.
COPY public/ public/
COPY config/ config/
COPY --from=build /app/dist/ dist
EXPOSE 9736/tcp
EXPOSE 3478/tcp
EXPOSE 3478/udp
EXPOSE 49152-65535/udp
CMD ["node", "dist/index.js"]
