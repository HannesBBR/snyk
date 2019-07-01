import {inspectors, Spec} from './inspectors';
import {MissingTargetFileError} from '../../errors/missing-targetfile-error';
import { SinglePackageResult, SingleSubprojectInspectOptions } from '@snyk/cli-interface/dist/legacy/plugin';

export function pluginName(): string {
  return 'rubygems';
}

export async function inspect(
    root: string,
    targetFile: string,
    options?: SingleSubprojectInspectOptions,
  ): Promise<SinglePackageResult> {
  if (!targetFile) {
    throw MissingTargetFileError(root);
  }
  const specs = await gatherSpecs(root, targetFile);

  return {
    plugin: {
      name: 'bundled:rubygems',
      runtime: 'unknown',
    },
    package: {
      name: specs.packageName,
      targetFile: specs.targetFile,
      files: specs.files,
    },
  };
}

async function gatherSpecs(root, targetFile): Promise<Spec> {
  for (const inspector of inspectors) {
    if (inspector.canHandle(targetFile)) {
      return await inspector.gatherSpecs(root, targetFile);
    }
  }

  throw new Error(`Could not handle file: ${targetFile}`);
}
