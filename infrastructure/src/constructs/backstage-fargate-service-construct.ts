// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { aws_ecs_patterns as ecsPatterns, StackProps } from "aws-cdk-lib";

import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";

import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { BackstageInfraConfig } from "../helpers/infra-config";
import { HostedZoneConstruct } from "./hostedzone-construct";
import { NetworkConstruct } from "./network-construct";

export type EnvVar = { [key: string]: string };
export type SecretVar = { [key: string]: ecs.Secret };

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface BackstageFargateServiceConstructProps extends StackProps {
  /**
   * The NetworkConstruct which provides the vpc and restricted IP security group references
   */
  readonly network: NetworkConstruct;
  /**
   * The ECR repository where Backstage docker images are pulled from for the service task's containers
   */
  readonly ecrRepository: ecr.IRepository;
  /**
   * A reference to the KMS key if the ECR repository has been encrypted
   * with a customer-managed key
   */
  readonly ecrKmsKey?: kms.IKey;
  /**
   * A reference to the S3 bucket to use for access log storage
   */
  readonly accessLogBucket: s3.IBucket,
  /**
   * The DatabaseCluster that the service will need to connect to
   */
  readonly dbCluster: rds.DatabaseCluster;
  /**
   * The BAWS infrastructure configuration
   */
  readonly config: BackstageInfraConfig;
  /**
   * A reference to the Secrets Manager secret where Okta secrets are held
   */
  readonly oktaSecret: ISecret;
  /**
   * A reference to the Secrets Manager secret where Gitlab Admin secrets are held
   */
  gitlabAdminSecret: ISecret;
  /**
   * An IAM role used for the service's tasks to have proper permission to
   * required AWS resources
   */
  readonly taskRole: iam.Role;
  /**
   * A Route53 Hosted Zone where the created ALB will be referenced in a
   * A record
   */
  readonly hostedZone: HostedZoneConstruct;
  /**
   * A set of key:value pairs to be used as environment variables in the
   * container task.  Do NOT add sensetive information in environment variables.
   * Sensetive information should be stored in SecretsManager and included
   * in the `secrets` parameter.
   */
  readonly envVars?: EnvVar;
  /**
   * A collection of additional secrets from Secret manager to be referenced
   * by the task containers when starting up.
   */
  readonly secretVars?: SecretVar;
}

const defaultProps: Partial<BackstageFargateServiceConstructProps> = {
  envVars: {},
  secretVars: {},
};

/**
 * A BackstageFargateServiceConstruct construct will create all AWS resources required
 * to run a service on ECS Fargate fronted by an application load balancer with
 * SSL communication.
 */
export class BackstageFargateServiceConstruct extends Construct {
  public readonly cluster: ecs.ICluster;
  public readonly loadBalancer: elb.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: BackstageFargateServiceConstructProps) {
    super(scope, id);

    /* eslint-disable @typescript-eslint/no-unused-vars */
    props = { ...defaultProps, ...props };

    // Create a secret to be used by service to service auth within Backstage.
    // See https://backstage.io/docs/auth/service-to-service-auth
    const backstageSecret = new Secret(this, `${props.config.AppPrefix}-backstage-appsecret`)

    const cluster = new ecs.Cluster(this, 'backstage-solution-cluster', {
      vpc: props.network.vpc,
      containerInsights: true,
    });

    // The ApplicationLoadBalancerFargateService constructor leverages a common pattern to create
    // AWS resources required to run a container as a Fargate service fronted by an Application
    // Load Balancer.  The configuration below will also ensure that http->https redirects occur,
    // and a certificate will be created for SSL termination at the ALB (along with a R53 record
    // pointing to the ALB)
    let albFargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      `${props.config.AppPrefix}-backstage`,
      {
        cluster,
        enableExecuteCommand: true,
        redirectHTTP: true,
        protocol: elb.ApplicationProtocol.HTTPS,
        taskImageOptions: {
          image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository),
          environment: {
            POSTGRES_HOST: props.dbCluster.clusterEndpoint.hostname,
            POSTGRES_PORT: `${props.dbCluster.clusterEndpoint.port}`,
            BACKSTAGE_TITLE: "Backstage AWS Suite",
            BACKSTAGE_ORGNAME: "BAWS",
            PROTOCOL: "https",
            BACKSTAGE_HOSTNAME: `${props.config.R53HostedZoneName}`,
            GITLAB_HOSTNAME: `git.${props.config.R53HostedZoneName}`,
            BACKSTAGE_PORT: "443",
            NODE_ENV: "production",
            CUSTOMER_NAME: `${props.config.CustomerName}`,
            CUSTOMER_LOGO: `${props.config.CustomerLogo}`,
            CUSTOMER_LOGO_ICON: `${props.config.CustomerLogoIcon}`,
            
          },
          secrets: {
            POSTGRES_USER: ecs.Secret.fromSecretsManager(props.dbCluster.secret!, "username"),
            POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(props.dbCluster.secret!, "password"),
            OKTA_ORG_URL: ecs.Secret.fromSecretsManager(props.oktaSecret, "audience"),
            OKTA_CLIENT_ID: ecs.Secret.fromSecretsManager(props.oktaSecret, "clientId"),
            OKTA_CLIENT_SECRET: ecs.Secret.fromSecretsManager(props.oktaSecret, "clientSecret"),
            OKTA_API_TOKEN: ecs.Secret.fromSecretsManager(props.oktaSecret, "apiToken"),
            BACKSTAGE_SECRET: ecs.Secret.fromSecretsManager(backstageSecret),
            GITLAB_ADMIN_TOKEN: ecs.Secret.fromSecretsManager(props.gitlabAdminSecret, "apiToken"),
          },
          containerPort: 8080,
          taskRole: props.taskRole,
        },
        openListener: false,
        memoryLimitMiB: 2048,
        cpu: 512,
        desiredCount: 2,
        domainZone: props.hostedZone.hostedZone,
        domainName: props.hostedZone.hostedZone.zoneName,
      }
    );

    // Save load balancer access logs to S3
    albFargateService.loadBalancer.logAccessLogs(props.accessLogBucket);

    // Ensure that the task can decrypt images in an encrypted repository
    if (props.ecrKmsKey) {
      props.ecrKmsKey.grantDecrypt(albFargateService.taskDefinition.executionRole!);
    }

    // Ensure that the DB security group allows access from the fargate service's SG
    props.dbCluster.connections.allowDefaultPortFrom(albFargateService.service, "from fargate service");

    // allow traffic to the ALB from the restricted IP security group
    albFargateService.loadBalancer.connections.addSecurityGroup(props.network.allowedIpsSg);

    this.loadBalancer = albFargateService.loadBalancer;
    this.cluster = cluster;
  }
}
