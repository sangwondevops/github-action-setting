import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { aws_elasticloadbalancingv2 as elbv2 } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { aws_logs as cwl } from 'aws-cdk-lib';
import { aws_servicediscovery as sd } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
export interface PipelineEcspressoConstructProps extends cdk.StackProps {
  prefix: string;
  appName: string;
  ecsCluster: ecs.Cluster;
  ecsServiceName: string;
  targetGroup?: elbv2.ApplicationTargetGroup;
  securityGroup: ec2.SecurityGroup;
  vpc: ec2.Vpc;
  logGroup: cwl.LogGroup;
  port: number;
  logGroupForServiceConnect?: cwl.LogGroup;
  cloudmapService: sd.IService;
  executionRole: iam.Role;
  taskRole?: iam.Role;
}

export class PipelineEcspressoConstruct extends Construct {
  constructor(scope: Construct, id: string, props: PipelineEcspressoConstructProps) {
    super(scope, id);

    //タスクロール,TargetGroupが指定されていない場合は、空文字をCodeBuildの環境変数として設定
    const taskRoleArn = props.taskRole?.roleArn || props.executionRole.roleArn;
    const targetGroupArn = props.targetGroup?.targetGroupArn || '';
    const logGroupForServiceConnect = props.logGroupForServiceConnect?.logGroupName || '';

    const sourceBucket = new s3.Bucket(this, `PipelineSourceBucket`, {
      versioned: true,
      eventBridgeEnabled: true,
    });
    sourceBucket.grantRead(props.executionRole, '.env');

    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        ECS_CLUSTER: {
          value: props.ecsCluster.clusterName,
        },
        ECS_SERVICE: {
          value: props.ecsServiceName,
        },
        TARGET_GROUP_ARN: {
          value: targetGroupArn,
        },
        SECURITY_GROUP: {
          value: props.securityGroup.securityGroupId,
        },
        // Subnet数が3の前提
        SUBNET_1: {
          value: props.vpc.selectSubnets({
            subnetGroupName: 'Private',
          }).subnetIds[0],
        },
        SUBNET_2: {
          value: props.vpc.selectSubnets({
            subnetGroupName: 'Private',
          }).subnetIds[1],
        },
        SUBNET_3: {
          value: props.vpc.selectSubnets({
            subnetGroupName: 'Private',
          }).subnetIds[2],
        },
        LOG_GROUP: {
          value: props.logGroup.logGroupName,
        },
        LOG_GROUP_SERVICE_CONNECT: {
          value: logGroupForServiceConnect,
        },
        EXECUTION_ROLE_ARN: {
          value: props.executionRole.roleArn,
        },
        TASK_ROLE: {
          value: taskRoleArn,
        },
        FAMILY: {
          value: `${props.prefix}-${props.appName}-Taskdef`,
        },
        REGISTRY_ARN: {
          value: props.cloudmapService.serviceArn,
        },
        ENVFILE_BUCKET_ARN: {
          value: sourceBucket.arnForObjects('.env'),
        },
        APP_PORT: {
          value: props.port,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              // 最新バージョンは表示しつつ、installは固定バージョンを使用
              'echo "The latest version of ecspresso is (It only shows up the log) :"',
              'curl -s https://api.github.com/repos/kayac/ecspresso/releases/latest | jq .tag_name',
              'curl -sL -o ecspresso-v2.0.3-linux-amd64.tar.gz https://github.com/kayac/ecspresso/releases/download/v2.0.3/ecspresso_2.0.3_linux_amd64.tar.gz',
              'tar -zxf ecspresso-v2.0.3-linux-amd64.tar.gz',
              'sudo install ecspresso /usr/local/bin/ecspresso',
              'ecspresso version',
            ],
          },
          build: {
            commands: [
                // Lambda 함수 구성 파일 경로 설정
    'LAMBDA_CONFIG_FILE="../../../../lambda/lambda_function_config.json"',
    'LAMBDA_CONFIG=$(cat $LAMBDA_CONFIG_FILE)',
              
    // JSON 구성 파일에서 값 추출
    'FUNCTION_NAME=$(echo $LAMBDA_CONFIG | jq -r ".FunctionName")',
    'MEMORY_SIZE=$(echo $LAMBDA_CONFIG | jq -r ".MemorySize")',
    'TIMEOUT=$(echo $LAMBDA_CONFIG | jq -r ".Timeout")',

    // S3에서 Lambda 함수 코드 다운로드
    'aws s3 cp s3://your-source-bucket/lambda_function.zip .',
              
    // Lambda 함수 업데이트 또는 생성
    'if aws lambda get-function --function-name $FUNCTION_NAME >/dev/null 2>&1; then',
    '  echo "Updating existing Lambda function...";',
    '  aws lambda update-function-code --function-name $FUNCTION_NAME --zip-file fileb://lambda_function.zip;',
    'else',
    '  echo "Creating new Lambda function...";',
    '  aws lambda create-function --function-name $FUNCTION_NAME --runtime nodejs14.x --role arn:aws:iam::your-account-id:role/your-lambda-role --handler index.handler --zip-file fileb://lambda_function.zip;',
    'fi',

    // ecspresso 설정 및 배포
    'export IMAGE_NAME=`cat imagedefinitions.json | jq -r .[0].imageUri`',
    'ls -lR',
    'ecspresso deploy --config ecspresso.yml',
    './autoscale.sh'
            ],
          },
        },
      }),
    });

    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ecs:RegisterTaskDefinition',
          'ecs:ListTaskDefinitions',
          'ecs:DescribeTaskDefinition',
          'ecs:CreateService',
          'ecs:UpdateService',
          'ecs:DescribeServices',
          'application-autoscaling:DescribeScalableTargets',
          'application-autoscaling:RegisterScalableTarget',
          'application-autoscaling:DeregisterScalableTarget',
          'application-autoscaling:PutScalingPolicy',
          'application-autoscaling:DeleteScalingPolicy',
          'application-autoscaling:DescribeScalingPolicies',
          'servicediscovery:GetNamespace',
          'iam:CreateServiceLinkedRole',
          'sts:AssumeRole',
        ],
        resources: ['*'],
      }),
    );

    if (props.taskRole) {
      deployProject.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [props.executionRole.roleArn, props.taskRole.roleArn],
        }),
      );
    } else {
      deployProject.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [props.executionRole.roleArn],
        }),
      );
    }

    const sourceOutput = new codepipeline.Artifact();

    // Code Pipeline Settings
    const sourceAction = new actions.S3SourceAction({
      actionName: 'SourceBucket',
      bucket: sourceBucket,
      bucketKey: 'image.zip',
      output: sourceOutput,
      trigger: actions.S3Trigger.NONE,
    });

    const deployAction = new actions.CodeBuildAction({
      actionName: 'DeployProject',
      input: sourceOutput,
      project: deployProject,
    });

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      crossAccountKeys: false,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [deployAction],
    });

    // Set code pipeline trigger via event bridge
    // When a new object is created in the s3 bucket, it generates an event.
    // That is, whenever the image.zip file is uploaded, the pipeline is executed.
    new events.Rule(this, 'PipelineTriggerEventRule', {
      eventPattern: {
        account: [cdk.Stack.of(this).account],
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [sourceBucket.bucketName],
          },
          object: {
            key: ['image.zip'],
          },
        },
      },
      targets: [new targets.CodePipeline(pipeline)],
    });

    cdk.Stack.of(this).exportValue(sourceBucket.bucketName, {
      // Dynamically set the name for verification in cloud formation
      name: `sourceBucket-${props.appName}`,
    });

    new ssm.StringParameter(this, `${props.appName}TriggerBucketName`, {
      parameterName: `/Hinagiku/TriggerBucket/${props.appName}`,
      stringValue: sourceBucket.bucketName,
    });
  }
}
