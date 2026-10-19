pipeline {
    agent any

    // Clean build history and avoid simultaneous builds on poll
    options {
        buildDiscarder(logRotator(numToKeepStr: '10'))
        disableConcurrentBuilds()
        timestamps()
        timeout(time: 15, unit: 'MINUTES')
    }

    // Poll SCM: Checks GitHub for new commits every 2-5 minutes
    triggers {
        pollSCM('H/3 * * * *')
    }

    environment {
        APP_PORT             = '5178'
        COMPOSE_PROJECT_NAME = 'rlns'
        RLNS_DATA_DIR        = 'D:/RLNS/data'
        RLNS_UPLOADS_DIR     = 'D:/RLNS/uploads'
    }

    stages {
        stage('Checkout SCM') {
            steps {
                echo "Pulling latest code changes from GitHub (Poll SCM)..."
                checkout scm
            }
        }

        stage('Syntax & Integrity Check') {
            steps {
                echo "Running node syntax validation..."
                script {
                    if (isUnix()) {
                        sh 'node -c backend/server.js'
                        sh 'node -c backend/oracleSync.js'
                    } else {
                        bat 'node -c backend\\server.js'
                        bat 'node -c backend\\oracleSync.js'
                    }
                }
            }
        }

        stage('Prepare Persistent Storage') {
            steps {
                echo "Ensuring persistent storage directories exist for PDFs and cache..."
                script {
                    if (isUnix()) {
                        sh 'mkdir -p ${RLNS_DATA_DIR} ${RLNS_UPLOADS_DIR} ${RLNS_UPLOADS_DIR}/temp'
                    } else {
                        bat 'if not exist D:\\RLNS\\data mkdir D:\\RLNS\\data'
                        bat 'if not exist D:\\RLNS\\uploads mkdir D:\\RLNS\\uploads'
                        bat 'if not exist D:\\RLNS\\uploads\\temp mkdir D:\\RLNS\\uploads\\temp'
                    }
                }
            }
        }

        stage('Deploy with Docker Compose') {
            steps {
                echo "Rebuilding and restarting RLNS containers via Docker Compose..."
                script {
                    if (isUnix()) {
                        sh 'docker compose down --remove-orphans || true'
                        sh 'docker compose up -d --build'
                    } else {
                        bat 'docker compose down --remove-orphans || rem'
                        bat 'docker compose up -d --build'
                    }
                }
            }
        }

        stage('Healthcheck & Verification') {
            steps {
                echo "Waiting for RLNS application to spin up..."
                sleep time: 12, unit: 'SECONDS'
                echo "Verifying health endpoint at http://127.0.0.1:${APP_PORT}/api/health..."
                script {
                    if (isUnix()) {
                        sh "curl -f --retry 5 --retry-delay 3 http://127.0.0.1:${APP_PORT}/api/health || exit 1"
                    } else {
                        bat "powershell -Command \"Invoke-RestMethod -Uri http://127.0.0.1:${APP_PORT}/api/health -TimeoutSec 5\""
                    }
                }
            }
        }
    }

    post {
        success {
            echo "================================================================="
            echo " RLNS deployment succeeded! Service live on port ${APP_PORT}."
            echo "================================================================="
        }
        failure {
            echo "================================================================="
            echo "❌ RLNS deployment failed! Inspect Jenkins console logs."
            echo "================================================================="
        }
    }
}
