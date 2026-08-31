def pipelineScript

pipeline {
    agent any

    tools {
        nodejs 'NodeJS 24'
    }

    stages {
        stage('Initialize') {
            steps {
                script {
                    pipelineScript = load 'script.groovy'
                }
            }
        }

        stage('Build') {
            steps {
                script {
                    pipelineScript.buildApp()
                }
            }
        }

        stage('Test') {
            steps {
                script {
                    pipelineScript.testApp()
                }
            }
        }

        stage('Deploy') {
            steps {
                script {
                    pipelineScript.deployApp()
                }
            }
        }
    }
}
