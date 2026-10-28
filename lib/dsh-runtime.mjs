export const isAsarPath = target => /\.asar[\\/]/i.test(String(target || ''))

/** ASAR paths need Electron's filesystem patches; ordinary scripts prefer standalone Node. */
export function scriptRuntime(target, { node = '', executable = process.execPath, electron = process.versions.electron } = {}) {
  if (isAsarPath(target)) {
    if (!electron) throw new Error('asar 内的 DSH 入口必须由 Electron 宿主运行；请使用桌面版，或填写解包后的 CLI 路径')
    return { command: executable, args: ['--expose-internals', target], shell: false, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: node || executable, args: [target], shell: false,
    env: !node && electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}

export function versionProbePassed(result) {
  return result.status === 0 && /\d+\.\d+\.\d+/.test(String(result.stdout || ''))
}
