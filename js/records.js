/* ============================================================
 * 推荐记录 —— 浏览器本地留档（localStorage），一次推荐 = 一条记录
 *
 * 为什么不用后端：数据是纯本地的，且彩票号码属于"随手记一下"的轻量信息，
 * 放 localStorage 就够，也不引入登录与同步。
 * 隐私模式 / 存储被禁用时降级为内存数组，功能照常用，只是关掉页面就没了。
 * ========================================================== */
(function (root) {
  'use strict';

  var KEY = 'lotto-records';
  var VERSION = 1;
  var MAX = 200;               // 最多留 200 条，超出淘汰最旧的

  var memory = null;           // localStorage 不可用时的降级容器

  function store() {
    try {
      var s = root.localStorage;
      if (!s) return null;
      s.setItem('__lotto_t', '1');
      s.removeItem('__lotto_t');
      return s;
    } catch (e) { return null; }   // 隐私模式下 setItem 会抛错
  }

  function read() {
    var s = store();
    if (!s) return memory || (memory = { v: VERSION, items: [] });
    try {
      var o = JSON.parse(s.getItem(KEY) || 'null');
      if (o && o.v === VERSION && Array.isArray(o.items)) return o;
    } catch (e) { /* 数据损坏 → 当空处理 */ }
    return { v: VERSION, items: [] };
  }

  function write(o) {
    var s = store();
    if (!s) { memory = o; return true; }
    try {
      s.setItem(KEY, JSON.stringify(o));
      return true;
    } catch (e) { memory = o; return false; }   // 配额满：退回内存，不打断用户
  }

  // 内容签名：同一批号码（同一推荐结果）重复打开结果页时不该再记一条
  function sigOf(it) {
    if (it && it.sig) return it.sig;
    return [it && it.kind, it && it.betType, it && it.dtForm,
      JSON.stringify(it && it.bet)].join('|');
  }

  function safeNum(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  /* ---------------- 对外接口 ---------------- */

  // 按推荐时间从新到旧
  function list() {
    return read().items.slice().sort(function (a, b) {
      return safeNum(b.at, 0) - safeNum(a.at, 0);
    });
  }

  function count() { return read().items.length; }

  function get(id) {
    var items = read().items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  // 返回写入的记录（已存在相同内容时，只把它的时间刷新成最新并返回原记录）
  function add(item) {
    if (!item) return null;
    var o = read();
    var sig = sigOf(item);
    item.at = safeNum(item.at, Date.now());
    for (var i = 0; i < o.items.length; i++) {
      if (sigOf(o.items[i]) === sig) {
        o.items[i].at = item.at;
        write(o);
        return o.items[i];
      }
    }
    item.id = item.id || ('r' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6));
    o.items.push(item);
    while (o.items.length > MAX) o.items.shift();   // 淘汰最旧
    write(o);
    return item;
  }

  function remove(id) {
    var o = read();
    var next = o.items.filter(function (it) { return it.id !== id; });
    if (next.length === o.items.length) return false;
    o.items = next;
    write(o);
    return true;
  }

  function clear() { write({ v: VERSION, items: [] }); }

  root.LR = {
    VERSION: VERSION,
    MAX: MAX,
    list: list,
    count: count,
    get: get,
    add: add,
    remove: remove,
    clear: clear
  };
})(window);
