const shell = document.getElementById('appShell');
const sidebar = document.getElementById('sidebar');
const toast = document.getElementById('toast');
const menuButton = document.getElementById('menuButton');
const collapseButton = document.getElementById('collapseButton');
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

menuButton.addEventListener('click', () => sidebar.classList.toggle('open'));
collapseButton.addEventListener('click', () => {
  shell.classList.toggle('collapsed');
  sidebar.classList.toggle('collapsed');
  showToast('Navigation density preview toggled');
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
    showToast(`${item.dataset.label} is represented as a visual route only`);
    if (window.innerWidth < 700) sidebar.classList.remove('open');
  });
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    const messages = {
      workspace: 'Workspace setup preview — backend connection is intentionally disabled',
      project: 'Project import preview — no project data is connected',
      command: 'Command entry preview — execution is intentionally disabled'
    };
    showToast(messages[action]);
  });
});
