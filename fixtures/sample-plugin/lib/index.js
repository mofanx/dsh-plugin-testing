// 门禁自检夹具的最小插件入口。
//
// 两处使用：
// 1. 静态门禁（`fixtures/conformance.selfcheck.json`）——只读 manifest，从不 import 本模块；
// 2. 运行时激活探针（`packages/testkit/tests/activate.spec.mjs`）——真实挂载为 loader 行。
//
// 这里曾经写着"若未来需要启动冒烟夹具，应另建可真实激活的最小插件"。实测表明本模块
// **已经**是可真实激活的最小插件（`apply()` 空实现即可），所以不再另建：探针的正例就用它，
// 与反面夹具 `../incompatible-plugin` 只差一个 peer 范围。
export function apply() {}
