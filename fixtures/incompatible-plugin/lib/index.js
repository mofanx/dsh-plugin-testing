// 运行时探针自证夹具：刻意声明不可满足的 peer（>=9.0.0）。
//
// 与 `../sample-plugin/lib/index.js` 逐字相同，只让 peer 范围成为唯一变量 ——
// 这样"探针检出 / 不检出"的差别只可能来自兼容性预检，而不是入口模块的写法。
export function apply() {}
