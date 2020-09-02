FROM ubuntu:18.04

ARG GROUP_ID
ARG USER_NAME
ARG USER_ID

# Avoid having packages query the user.
ARG DEBIAN_FRONTEND=noninteractive

RUN set -ex


# apt-get for misc. packages
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y \
    python3.8 \
    python2.7 \
    curl \
    xz-utils \
    git \
    vim \
    gnupg \
    wget \
    build-essential && \
    apt-get clean

# Install and start mongodb instance (needed for mongoose clients)
RUN wget -qO - https://www.mongodb.org/static/pgp/server-4.2.asc |  apt-key add -
RUN echo "deb [ arch=amd64 ] https://repo.mongodb.org/apt/ubuntu bionic/mongodb-org/4.2 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-4.2.list
RUN apt-get update
RUN apt-get install -y mongodb-org
RUN mkdir -p /data/db
RUN mongod --fork --logpath /var/log/mongodb-newlog.log

RUN groupadd -g ${GROUP_ID} collateral-evolution
RUN useradd --gid collateral-evolution --uid ${USER_ID} -ms /bin/bash ${USER_NAME}

USER ${USER_NAME}:collateral-evolution
WORKDIR /home/${USER_NAME}

# Install node
RUN curl https://nodejs.org/dist/v12.13.1/node-v12.13.1-linux-x64.tar.xz -o node.tar.xz
RUN tar -xf node.tar.xz
ENV PATH=/home/${USER_NAME}/node-v12.13.1-linux-x64/bin:${PATH}

RUN node --version
RUN npm install -g mocha@6.2.2 gulp@4.0.2 grunt@1.0.4 node-gyp@6.0.1 \
  jest@24.9.0 resin-lint@3.1.1 jshint@2.10.3 bower@1.8.8 \
  yarn@1.21.0

