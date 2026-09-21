/* =========================================================
 * config.js —— 非敏感配置
 *
 * 重要：
 * 1. 这里绝对不能填写 GitHub Token、密码、私钥或任何敏感信息。
 * 2. 本文件会公开在 GitHub Pages 上，任何人都能看到它的内容。
 * 3. Token 只能在网页里手动输入，只保存在浏览器的 sessionStorage 中。
 * ========================================================= */

window.APP_CONFIG = {

  /* GitHub 用户名（必改：改成你自己的 GitHub 用户名或组织名） */
  OWNER: 'anthonyzhu1130',

  /* GitHub 仓库名称（必改：如果仓库名不是 cloud-notes，请改成实际名称） */
  REPO: 'cloud-notes',

  /* 默认分支 */
  BRANCH: 'main',

  /* 笔记数据文件路径 */
  NOTES_PATH: 'data/notes.json',

  /* 图片保存根目录 */
  IMAGE_ROOT: 'assets/images',

  /* 附件保存根目录 */
  FILE_ROOT: 'assets/files',

  /* 网站名称 */
  SITE_TITLE: '我的云端笔记',

  /* 单张图片最大字节数（5 MB） */
  MAX_IMAGE_SIZE: 5 * 1024 * 1024,

  /* 单个附件最大字节数（10 MB） */
  MAX_FILE_SIZE: 10 * 1024 * 1024,

  /* 允许的图片扩展名（小写，不带点） */
  ALLOWED_IMAGE_EXTENSIONS: ['jpg', 'jpeg', 'png', 'gif', 'webp'],

  /* 允许的附件扩展名（小写，不带点） */
  ALLOWED_FILE_EXTENSIONS: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip'],

  /* GitHub REST API 版本 */
  API_VERSION: '2022-11-28',

  /* 是否显示示例数据提示（true / false） */
  SHOW_SAMPLE_DATA: false,

  /* 主页上的常用链接：想加就加一行，想删就删一行 */
  QUICK_LINKS: [
    { name: '百度', url: 'https://www.baidu.com', icon: '🔍' },
    { name: 'GitHub', url: 'https://github.com', icon: '🐙' },
    { name: '知乎', url: 'https://www.zhihu.com', icon: '📚' },
    { name: 'B 站', url: 'https://www.bilibili.com', icon: '📺' }
  ]
};
