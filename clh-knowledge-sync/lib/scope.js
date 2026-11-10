/**
 * scope（作用域）工具：项目/模块两级命名空间，解决多项目共用 hub 时的条目冲突与越权。
 *
 * 语法（与方案 §5.1 一致）：
 *   ""                     全局共享层
 *   "proj:<name>"          项目层
 *   "proj:<name>:mod:<n>"  模块层
 *   name: 小写字母/数字/ - _，且首字符是字母或数字
 *
 * 授权令牌（hub nodeTokens 的 scopes）在上述之外还支持通配：
 *   "*"          全作用域
 *   "proj:*"     所有项目/模块（不含全局层）
 *   "proj:x:*"   项目 x 及其全部模块
 *
 * 读 = 继承读取：scope="proj:x:mod:y" 的节点可读 [""、"proj:x"、"proj:x:mod:y"]；
 * 授权侧再叠通配。写 = 精确命中：scope 必须被某条授权覆盖（精确或通配）。
 */
export const SCOPE_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;
export const isValidScope = (s) => {
    if (typeof s !== 'string')
        return false;
    if (s === '')
        return true;
    const p = s.split(':');
    if (p.length !== 2 && p.length !== 4)
        return false;
    if (p[0] !== 'proj' || !SCOPE_SEGMENT.test(p[1]))
        return false;
    if (p.length === 4 && (p[2] !== 'mod' || !SCOPE_SEGMENT.test(p[3])))
        return false;
    return true;
};
/** 授权条目：合法 scope（含 "" 全局层）、"*"、或 "<scope>:*" 通配（如 proj:*、proj:x:*）。 */
export const isValidGrant = (s) => {
    if (typeof s !== 'string')
        return false;
    if (s === '*' || s === 'proj:*')
        return true;
    if (s.endsWith(':*'))
        return isValidScope(s.slice(0, -2)) && s.slice(0, -2) !== '';
    return isValidScope(s);
};
/** scope 的继承读取闭包：proj:x:mod:y → ["", "proj:x", "proj:x:mod:y"]；"" → [""]. */
export const scopeAncestors = (scope) => {
    if (scope === '')
        return [''];
    const p = scope.split(':');
    const out = ['', `proj:${p[1]}`];
    if (p.length === 4)
        out.push(scope);
    return out;
};
/** grant 是否覆盖 scope（写判定的唯一规则）。 */
export const grantCovers = (grant, scope) => {
    if (grant === '*')
        return true;
    if (grant === scope)
        return true;
    if (grant === 'proj:*')
        return scope.startsWith('proj:');
    if (grant.endsWith(':*')) {
        const base = grant.slice(0, -2);
        return scope === base || scope.startsWith(base + ':');
    }
    return false;
};
/** 写：任一授权覆盖即可。 */
export const canWrite = (grants, scope) => grants.some((g) => grantCovers(g, scope));
/** 读：scope 被任一授权覆盖（精确命中或通配）。无隐式祖先继承——
 *  全局层 "" 必须显式授权（与方案授权示例 ["", "proj:x", "proj:x:*"] 一致）；
 *  节点侧的继承读取体现在请求参数上（sync.readScopes = 写 scope 的祖先闭包，
 *  服务端再与 grants 求交）。 */
export const canRead = (grants, scope) => grants.some((g) => grantCovers(g, scope));
/** scope → 嵌套目录段："proj:x:mod:y" → ["proj","x","mod","y"]；"" → []（不落子目录）。 */
export const scopePathParts = (scope) => scope === '' ? [] : scope.split(':');
/** scope → 扁平文件名前缀："proj:x:mod:y" → "proj~x~mod~y__"；"" → ""（无前缀）。 */
export const scopeFilePrefix = (scope) => scope === '' ? '' : scope.split(':').join('~') + '__';
