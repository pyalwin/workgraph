'use client';

import React from 'react';
import { ProjectMap } from './project-map';
import { LifespanStrip } from './lifespan-strip';
import { ActivityStrip } from './activity-strip';
import { DriftBar } from './drift-bar';
import { FileHeatmap } from './file-heatmap';
import { Swimlane } from './swimlane';
import { DriftHeatmap } from './drift-heatmap';

export function renderDiagram(kind: string, params: unknown): React.ReactElement | null {
  switch (kind) {
    case 'project_map':
      return <ProjectMap params={params} />;
    case 'lifespan_strip':
      return <LifespanStrip params={params} />;
    case 'activity_strip':
      return <ActivityStrip params={params} />;
    case 'drift_bar':
      return <DriftBar params={params} />;
    case 'file_heatmap':
      return <FileHeatmap params={params} />;
    case 'swimlane':
      return <Swimlane params={params} />;
    case 'drift_heatmap':
      return <DriftHeatmap params={params} />;
    default:
      return null;
  }
}
