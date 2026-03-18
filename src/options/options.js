const interceptionMode = document.getElementById('interception-mode');
const defaultType = document.getElementById('default-type');
const autoConvert = document.getElementById('auto-convert');
const status = document.getElementById('status');

// Load saved settings
chrome.storage.local.get(['interceptionMode', 'defaultType', 'autoConvert'], (data) => {
  if (data.interceptionMode) interceptionMode.value = data.interceptionMode;
  if (data.defaultType) defaultType.value = data.defaultType;
  if (data.autoConvert !== undefined) autoConvert.checked = data.autoConvert;
});

function save() {
  chrome.storage.local.set({
    interceptionMode: interceptionMode.value,
    defaultType: defaultType.value,
    autoConvert: autoConvert.checked,
  }, () => {
    status.textContent = 'Settings saved';
    setTimeout(() => { status.textContent = ''; }, 1500);
  });
}

interceptionMode.addEventListener('change', save);
defaultType.addEventListener('change', save);
autoConvert.addEventListener('change', save);
