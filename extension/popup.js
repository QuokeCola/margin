const $ = s => document.querySelector(s);
function show(m) {
  const st = $('#state');
  st.className = m?.paired ? '' : 'bad';
  st.textContent = !m ? 'Margin is not running. Start it, then reopen this.' : m.paired ? `Connected to Margin${m.pending ? ` · waiting for ${m.pending} paper${m.pending === 1 ? '' : 's'}` : ''}.` : 'Found Margin, but not paired yet.';
  $('#pair').hidden = !m || m.paired;
  $('#send').hidden = !m?.paired;
}
chrome.runtime.sendMessage({type: 'status'}, r => show(r?.margin));
$('#save').onclick = () => chrome.runtime.sendMessage({type: 'pair', code: $('#code').value.trim()}, r => { show(r?.margin); $('#msg').textContent = r?.margin?.paired ? 'Paired.' : 'That code was not accepted.'; });
$('#send').onclick = async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  $('#msg').textContent = 'Sending…'; $('#send').disabled = true;
  chrome.runtime.sendMessage({type: 'send-tab', tabId: tab.id}, r => {
    $('#send').disabled = false;
    $('#msg').textContent = r?.ok ? `Added to “${r.project}”.` : r?.error === 'no-margin' ? 'Margin is not running.' : r?.error === 'not-paired' ? 'Not paired.' : (r?.error || 'Failed.');
  });
};
