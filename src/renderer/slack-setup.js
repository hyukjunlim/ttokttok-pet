'use strict';

// The Slack setup window's page. The token goes straight from its field to the main process and
// is never shown or kept here; the field is cleared once it has been accepted. Once the canvas has
// been read, the page lists the turns it found, so a name that doesn't match shows at once.

(() => {
  const form = document.getElementById('form');
  const token = document.getElementById('token');
  const link = document.getElementById('link');
  const name = document.getElementById('name');
  const status = document.getElementById('status');
  const ok = document.getElementById('ok');
  const cancel = document.getElementById('cancel');
  const guide = document.getElementById('guide');
  let busy = false;
  let hasToken = false;

  function show(text, kind) {
    status.textContent = text;
    status.className = kind || '';
  }

  function setBusy(on) {
    busy = on;
    ok.disabled = on;
    for (const input of [token, link, name]) input.readOnly = on;
  }

  guide.addEventListener('click', (e) => {
    e.preventDefault();
    window.slackSetup.openGuide();
  });

  cancel.addEventListener('click', () => window.slackSetup.close());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.slackSetup.close();
  });

  for (const input of [token, link, name]) {
    input.addEventListener('input', () => {
      if (!busy && status.className === 'error') show('', '');
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const missing = !token.value.trim() && !hasToken ? [token, '토큰을 입력해 주세요.']
      : !link.value.trim() ? [link, '캔버스 링크를 입력해 주세요.']
        : !name.value.trim() ? [name, '이름을 입력해 주세요.'] : null;
    if (missing) {
      show(missing[1], 'error');
      missing[0].focus();
      return;
    }
    setBusy(true);
    show('Slack에서 캔버스를 읽는 중…', 'pending');
    let reply;
    try {
      reply = await window.slackSetup.submit({ token: token.value, link: link.value, name: name.value });
    } catch {
      reply = { ok: false, error: 'Slack에서 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
    }
    setBusy(false);
    if (reply && reply.ok) {
      token.value = '';
      hasToken = true;
      token.placeholder = '저장된 토큰 사용';
      const turns = Array.isArray(reply.turns) ? reply.turns : [];
      show(turns.length
        ? `저장했습니다. 앞으로의 발표 ${turns.length}개:\n${turns.join('\n')}`
        : '저장했습니다. 다만 앞으로 잡힌 발표를 찾지 못했습니다. 이름이 표에 적힌 그대로인지 확인해 주세요.', 'success');
      return;
    }
    show((reply && reply.error) || 'Slack에서 확인하지 못했습니다.', 'error');
  });

  window.slackSetup.initial().then((init) => {
    if (!init) return;
    hasToken = init.hasToken === true;
    if (hasToken) token.placeholder = '저장된 토큰 사용';
    if (!link.value) link.value = init.link || '';
    if (!name.value) name.value = init.name || '';
    (hasToken ? (link.value ? name : link) : token).focus();
  }).catch(() => token.focus());
})();
