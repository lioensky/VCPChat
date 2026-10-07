// modules/services/dotGitPath.js
// 判断一个路径段是不是 .git。NTFS 上 .git 还有别名：8.3 短名 GIT~1、末尾带点或空格、
// .git::$INDEX_ALLOCATION 这类流名，都会落到同一个目录（同 git 的 is_ntfs_dotgit，CVE-2014-9390 / CVE-2019-1352）。
// 其它平台上这些名字本身就不常见，一并拒绝不影响正常使用。
'use strict';

function isDotGitSegment(segment) {
    const name = String(segment).toLowerCase().split(':')[0].replace(/[. ]+$/, '');
    return name === '.git' || /^git~\d+$/.test(name);
}

module.exports = { isDotGitSegment };
