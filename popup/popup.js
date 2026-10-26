// UBB popup: connection status, token (masked by default), port, shield mode, session info.

const $ = (id) => document.getElementById(id);

let fullToken = '';
let revealed = false;

function renderToken() {
  $('token').textContent = fullToken
    ? (revealed ? fullToken : fullToken.slice(0, 6) + ' … ' + fullToken.slice(-4))
    : '…';
  $('reveal').textContent = revealed ? '隐藏' : '显示';
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: 'UBB_POPUP_STATE' });
  if (!st) return;
  const badge = $('status');
  badge.textContent =
    st.connected ? '已连接' : st.status === 'connecting' || st.status === 'waiting_auth' ? '连接中' : '未连接';
  badge.className = 'status ' + (st.connected ? 'on' : st.status === 'off' ? 'off' : 'mid');
  if (st.token !== fullToken) revealed = false;
  fullToken = st.token || '';
  renderToken();
  $('port').value = st.port;
  $('enabled').checked = !!st.enabled;
  $('humanMode').checked = !!st.human_mode;
  $('shieldMode').value = st.shield_mode;
  $('session').textContent = st.session
    ? `会话 ${st.session.id} · 自建 ${st.session.created} · 接管 ${st.session.claimed}`
    : '会话：无（agent 调 session.start / tab.create 时自动建立）';
  $('audit').textContent = (st.audit_tail || [])
    .map((a) => `${new Date(a.t).toLocaleTimeString()} ${a.action} ${a.ok ? '✓' : '✗ ' + (a.error || '')}`)
    .join('\n');
}

async function saveNow() {
  await chrome.runtime.sendMessage({
    type: 'UBB_POPUP_CONFIG',
    port: Number($('port').value),
    enabled: $('enabled').checked,
    shield_mode: $('shieldMode').value,
    human: $('humanMode').checked,
  });
  refresh();
}

// toggles apply immediately — the 2s state poll would otherwise revert them
$('enabled').addEventListener('change', saveNow);
$('humanMode').addEventListener('change', saveNow);
$('shieldMode').addEventListener('change', saveNow);
$('save').addEventListener('click', saveNow);

$('reveal').addEventListener('click', () => {
  revealed = !revealed;
  renderToken();
});

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(fullToken);
  $('copy').textContent = '已复制';
  setTimeout(() => ($('copy').textContent = '复制'), 1200);
});

$('regen').addEventListener('click', async () => {
  if (!confirm('重置令牌后，daemon 也需要换用新令牌重启。继续？')) return;
  await chrome.runtime.sendMessage({ type: 'UBB_POPUP_REGEN_TOKEN' });
  refresh();
});

$('applyToken').addEventListener('click', async () => {
  const t = $('tokenInput').value.trim();
  if (!/^[0-9a-f]{16,128}$/i.test(t)) {
    alert('令牌格式应为 16–128 位十六进制');
    return;
  }
  await chrome.runtime.sendMessage({ type: 'UBB_POPUP_CONFIG', token: t });
  $('tokenInput').value = '';
  refresh();
});

refresh();
setInterval(refresh, 2000);
