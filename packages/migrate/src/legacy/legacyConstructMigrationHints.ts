export interface LegacyMigrationHint {
  original: string;
  recommendation: string;
  example?: string;
}

export function fbTaskWithMigration(
  instanceName: string,
  taskName: string,
): LegacyMigrationHint {
  const instance = instanceName.trim();
  const task = taskName.trim();
  return {
    original: `${instance} WITH ${task}`,
    recommendation:
      'IEC 61131-3:2025 keeps task association at PROGRAM level; invoke this function block from a program already associated with the task.',
    example: `PROGRAM Control WITH ${task} : ControlProgram();`,
  };
}

export function graphicalEdgeDeclarationMigration(
  signalName: string,
  edge: 'R_EDGE' | 'F_EDGE',
): LegacyMigrationHint {
  const signal = signalName.trim();
  const functionBlockType = edge === 'R_EDGE' ? 'R_TRIG' : 'F_TRIG';
  const instanceName = `${signal}_${functionBlockType}`;
  return {
    original: `${signal} : BOOL ${edge}`,
    recommendation:
      'Replace graphical BOOL edge declarations with explicit standard edge-detector function block instances.',
    example: `${instanceName} : ${functionBlockType};\n${instanceName}(CLK := ${signal});`,
  };
}

export function actionBlockIndicatorMigration(
  actionName: string,
  indicatorName: string,
): LegacyMigrationHint {
  const action = actionName.trim();
  const indicator = indicatorName.trim();
  return {
    original: `${action}(..., ${indicator})`,
    recommendation:
      'Replace action-block indicator variables with explicit action state or completion variables assigned in canonical ST/SFC logic.',
    example: `${indicator} := TRUE; (* set inside ACTION ${action} when the action completion condition is met *)`,
  };
}

export function graphicalActionBlockMigration(
  actionName: string,
): LegacyMigrationHint {
  const action = actionName.trim();
  return {
    original: `<actionBlock ... referenceName="${action}" />`,
    recommendation:
      'Preserve imported graphical action blocks only as migration metadata; remodel the action as canonical ST or SFC ACTION text before export.',
    example: `ACTION ${action}:\n  (* migrated action logic *)\nEND_ACTION`,
  };
}
