const state = {
  user: null,
  pets: [],
  posts: [],
  appointments: [],
  nextCursor: null,
  selectedPetId: null,
  editingPetId: null,
  editingPostId: null,
  originalPostImages: [],
  existingPostImages: [],
  pendingFiles: [],
  editingAppointmentId: null,
  adminUsers: [],
  adminPets: [],
  adminAppointments: [],
  editingAdminPetId: null,
  editingAdminAppointmentId: null,
  petCreateRequestId: null,
  adminPetCreateRequestId: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const toast = $('#toast');
let toastTimer;

const api = async (url, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请稍后重试');
    error.status = response.status;
    throw error;
  }
  return data;
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function showPage(name) {
  if (name === 'admin' && !isAdmin()) {
    showToast('仅管理员可以访问管理后台');
    name = 'home';
  }
  $$('.page').forEach((page) => page.classList.toggle('active', page.dataset.page === name));
  $$('[data-page-target]').forEach((button) => button.classList.toggle('active', button.dataset.pageTarget === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'feed' && !state.posts.length) loadPosts(true);
  if (name === 'booking') prepareBooking();
  if (name === 'profile') renderPets();
  if (name === 'admin') loadAdminPage();
}

$$('[data-page-target]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.pageTarget)));

function requireLogin() {
  if (state.user) return true;
  $('#auth-dialog').showModal();
  return false;
}

async function initialize() {
  setDateBounds();
  try {
    state.user = (await api('/api/auth/session')).user;
  } catch (error) {
    showToast(error.message);
  }
  syncAccount();
  await Promise.all([loadPosts(true), state.user ? loadPets() : Promise.resolve()]);
  if (state.user) await loadAppointments();
}

function syncAccount() {
  const button = $('#account-button');
  if (!state.user) {
    button.textContent = '登录 / 注册';
    button.onclick = () => $('#auth-dialog').showModal();
    $('#pet-search').hidden = true;
    $$('[data-admin-only]').forEach((node) => { node.hidden = true; });
    return;
  }
  button.textContent = `${state.user.displayName}${roleSuffix(state.user.role)}`;
  $('#pet-search').hidden = !hasStaffAccess(state.user.role);
  $$('[data-admin-only]').forEach((node) => { node.hidden = !isAdmin(); });
  button.onclick = async () => {
    if (!confirm('确定退出当前账号吗？')) return;
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    state.user = null;
    state.pets = [];
    state.appointments = [];
    state.adminUsers = [];
    state.adminPets = [];
    state.adminAppointments = [];
    if ($('[data-page="admin"]').classList.contains('active')) showPage('home');
    syncAccount();
    syncPetUi();
    renderPets();
    renderAppointments();
    await loadPosts(true);
    showToast('已退出登录');
  };
}

let petSearchTimer;
$('#pet-search').oninput = (event) => {
  clearTimeout(petSearchTimer);
  petSearchTimer = setTimeout(() => loadPets(event.target.value.trim()), 250);
};

$('#close-auth').onclick = () => $('#auth-dialog').close();
$$('[data-auth-tab]').forEach((button) => button.onclick = () => {
  $$('[data-auth-tab]').forEach((item) => item.classList.toggle('active', item === button));
  $('#login-form').hidden = button.dataset.authTab !== 'login';
  $('#register-form').hidden = button.dataset.authTab !== 'register';
  $$('[data-auth-error]').forEach((node) => node.textContent = '');
});

$('#login-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorNode = $('[data-auth-error]', form);
  errorNode.textContent = '';
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    state.user = (await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) })).user;
    $('#auth-dialog').close();
    form.reset();
    syncAccount();
    await Promise.all([loadPets(), loadAppointments(), loadPosts(true)]);
    showToast(`欢迎回来，${state.user.displayName}`);
  } catch (error) {
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$('#register-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorNode = $('[data-auth-error]', form);
  errorNode.textContent = '';
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(values) });
    state.user = result.user;
    $('#auth-dialog').close();
    form.reset();
    syncAccount();
    await Promise.all([loadPets(), loadAppointments(), loadPosts(true)]);
    showToast('账号创建成功，已自动登录');
  } catch (error) {
    errorNode.style.color = '';
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

async function loadPets(query = '') {
  if (!state.user) return;
  try {
    state.pets = (await api(`/api/pets${query ? `?query=${encodeURIComponent(query)}` : ''}`)).pets;
    if (!state.pets.some((pet) => pet.id === state.selectedPetId)) state.selectedPetId = state.pets[0]?.id || null;
    syncPetUi();
    renderPets();
  } catch (error) {
    showToast(error.message);
  }
}

function syncPetUi() {
  const pet = state.pets.find((item) => item.id === state.selectedPetId);
  const heroAvatar = $('#hero-avatar');
  const heroTitle = $('#hero-title');
  const heroMeta = $('#hero-meta');
  const petSwitch = $('#pet-switch');
  if (!state.user) {
    heroAvatar.textContent = '🐾';
    heroTitle.textContent = '记录每一次用心养护';
    heroMeta.textContent = '登录并添加宠物后，即可预约洗护和分享养护前后变化。';
    petSwitch.hidden = true;
  } else if (!pet) {
    heroAvatar.textContent = '＋';
    heroTitle.textContent = '先添加一只宠物吧';
    heroMeta.textContent = '完善宠物档案后即可开始发布动态和预约洗护。';
    petSwitch.hidden = true;
  } else {
    heroAvatar.textContent = speciesIcon(pet.species);
    heroTitle.textContent = `${pet.name}，今天状态怎么样？`;
    heroMeta.textContent = [pet.breed || speciesLabel(pet.species), pet.weightKg ? `${pet.weightKg} kg` : '', pet.ownerName && hasStaffAccess(state.user.role) ? `主人：${pet.ownerName}` : ''].filter(Boolean).join(' · ');
    petSwitch.hidden = state.pets.length < 2;
    petSwitch.replaceChildren(...state.pets.map((item) => option(item.id, `${speciesIcon(item.species)} ${item.name}`)));
    petSwitch.value = pet.id;
  }
  for (const select of [$('#post-pet'), $('#booking-pet')]) {
    select.replaceChildren(...state.pets.map((item) => option(item.id, `${speciesIcon(item.species)} ${item.name}${hasStaffAccess(state.user?.role) && item.ownerName ? ` · ${item.ownerName}` : ''}`)));
    if (state.selectedPetId) select.value = state.selectedPetId;
  }
}

$('#pet-switch').onchange = (event) => {
  state.selectedPetId = event.target.value;
  syncPetUi();
};

$('#add-pet').onclick = () => {
  if (!requireLogin()) return;
  state.editingPetId = null;
  state.petCreateRequestId = crypto.randomUUID();
  $('#pet-form').reset();
  $('#pet-form-title').textContent = '添加宠物';
  $('#pet-error').textContent = '';
  $('#pet-form').hidden = false;
  $('#pet-form [name="name"]').focus();
};
$('#close-pet-form').onclick = closePetForm;
function closePetForm() {
  state.editingPetId = null;
  state.petCreateRequestId = null;
  $('#pet-form').hidden = true;
  $('#pet-error').textContent = '';
}

$('#pet-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting === 'true') return;
  form.dataset.submitting = 'true';
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = { ...values, birthDate: values.birthDate || null, weightKg: values.weightKg ? Number(values.weightKg) : null };
  if (!state.editingPetId) payload.requestId = state.petCreateRequestId || (state.petCreateRequestId = crypto.randomUUID());
  $('#pet-error').textContent = '';
  try {
    const url = state.editingPetId ? `/api/pets/${state.editingPetId}` : '/api/pets';
    await api(url, { method: state.editingPetId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    showToast(state.editingPetId ? '宠物档案已更新' : '宠物添加成功');
    closePetForm();
    await loadPets();
  } catch (error) {
    $('#pet-error').textContent = error.message;
  } finally {
    form.dataset.submitting = 'false';
    submit.disabled = false;
  }
};

function renderPets() {
  const list = $('#pet-list');
  if (!state.user) {
    list.innerHTML = '<div class="panel empty">登录后管理宠物档案。</div>';
    return;
  }
  if (!state.pets.length) {
    list.innerHTML = '<div class="panel empty">还没有宠物档案，点击“添加宠物”开始。</div>';
    return;
  }
  list.replaceChildren(...state.pets.map((pet) => {
    const card = document.createElement('article');
    card.className = 'pet-card';
    const own = pet.ownerId === state.user.id;
    card.innerHTML = `<div class="pet-card-avatar">${speciesIcon(pet.species)}</div><h3>${escapeHtml(pet.name)}</h3><p>${escapeHtml(pet.breed || speciesLabel(pet.species))}${pet.weightKg ? ` · ${pet.weightKg} kg` : ''}</p>${pet.ownerName && hasStaffAccess(state.user.role) ? `<p>主人：${escapeHtml(pet.ownerName)}</p>` : ''}<div class="card-actions" ${own ? '' : 'hidden'}><button data-edit-pet>编辑</button><button class="danger" data-delete-pet>删除</button></div>`;
    $('[data-edit-pet]', card)?.addEventListener('click', () => beginPetEdit(pet));
    $('[data-delete-pet]', card)?.addEventListener('click', () => deletePet(pet));
    return card;
  }));
}

function beginPetEdit(pet) {
  state.editingPetId = pet.id;
  state.petCreateRequestId = null;
  const form = $('#pet-form');
  form.hidden = false;
  $('#pet-form-title').textContent = `编辑 ${pet.name}`;
  for (const name of ['name', 'species', 'breed', 'sex', 'birthDate', 'weightKg']) form.elements[name].value = pet[name] ?? '';
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deletePet(pet) {
  if (!confirm(`确定删除 ${pet.name} 的档案吗？已有预约或动态时无法删除。`)) return;
  try {
    await api(`/api/pets/${pet.id}`, { method: 'DELETE' });
    await loadPets();
    showToast('宠物档案已删除');
  } catch (error) {
    showToast(error.message);
  }
}

$('#open-composer').onclick = () => openComposer();
$('#close-composer').onclick = closeComposer;
$('#cancel-post-edit').onclick = closeComposer;
$('#feed-phase').onchange = () => loadPosts(true);
$('#post-images').onchange = (event) => {
  const selected = [...event.target.files];
  if (state.existingPostImages.length + state.pendingFiles.length + selected.length > 6) {
    showToast('每条动态最多 6 张图片');
  } else {
    state.pendingFiles.push(...selected);
  }
  event.target.value = '';
  renderImagePreviews();
};

function openComposer(post = null) {
  if (!requireLogin()) return;
  if (!state.pets.length) {
    showToast('请先添加宠物档案');
    showPage('profile');
    return;
  }
  const form = $('#post-form');
  form.hidden = false;
  form.reset();
  state.editingPostId = post?.id || null;
  state.originalPostImages = post ? [...post.images] : [];
  state.existingPostImages = post ? [...post.images] : [];
  state.pendingFiles = [];
  $('#composer-title').textContent = post ? '编辑养护动态' : '发布养护动态';
  $('#submit-post').textContent = post ? '保存修改' : '发布动态';
  $('#post-error').textContent = '';
  form.elements.petId.value = post?.petId || state.selectedPetId;
  form.elements.phase.value = post?.phase || 'before';
  form.elements.body.value = post?.body || '';
  renderImagePreviews();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeComposer() {
  $('#post-form').hidden = true;
  state.editingPostId = null;
  state.originalPostImages = [];
  state.existingPostImages = [];
  state.pendingFiles = [];
  renderImagePreviews();
}

function renderImagePreviews() {
  const grid = $('#image-previews');
  grid.textContent = '';
  const items = [
    ...state.existingPostImages.map((image) => ({ type: 'existing', image })),
    ...state.pendingFiles.map((file) => ({ type: 'file', file }))
  ];
  items.forEach((item, index) => {
    const node = document.createElement('div');
    node.className = 'preview';
    const img = document.createElement('img');
    img.alt = `待上传图片 ${index + 1}`;
    img.src = item.type === 'existing' ? item.image.url : URL.createObjectURL(item.file);
    node.append(img);
    const actions = document.createElement('div');
    actions.className = 'preview-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.onclick = () => {
      if (item.type === 'existing') state.existingPostImages = state.existingPostImages.filter((image) => image.id !== item.image.id);
      else state.pendingFiles = state.pendingFiles.filter((file) => file !== item.file);
      renderImagePreviews();
    };
    actions.append(remove);
    node.append(actions);
    grid.append(node);
  });
  $('#upload-hint').textContent = `${items.length} / 6 张 · JPEG / PNG / WebP，单张不超过 8 MB`;
}

$('#post-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('#submit-post');
  $('#post-error').textContent = '';
  submit.disabled = true;
  try {
    const data = new FormData();
    data.set('petId', form.elements.petId.value);
    data.set('phase', form.elements.phase.value);
    data.set('body', form.elements.body.value);
    state.pendingFiles.forEach((file) => data.append('images', file));
    if (state.editingPostId) {
      const keptIds = state.existingPostImages.map((image) => image.id);
      data.set('removeImageIds', JSON.stringify(state.originalPostImages.filter((image) => !keptIds.includes(image.id)).map((image) => image.id)));
      data.set('imageOrder', JSON.stringify(keptIds));
    }
    await api(state.editingPostId ? `/api/posts/${state.editingPostId}` : '/api/posts', {
      method: state.editingPostId ? 'PATCH' : 'POST',
      body: data
    });
    showToast(state.editingPostId ? '动态已更新' : '动态发布成功');
    closeComposer();
    await loadPosts(true);
  } catch (error) {
    $('#post-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

async function loadPosts(reset = false) {
  const list = $('#feed-list');
  if (reset) {
    state.posts = [];
    state.nextCursor = null;
    list.innerHTML = '<div class="panel empty">正在加载动态…</div>';
  }
  try {
    const params = new URLSearchParams();
    if ($('#feed-phase').value) params.set('phase', $('#feed-phase').value);
    if (!reset && state.nextCursor) params.set('cursor', state.nextCursor);
    const result = await api(`/api/posts?${params}`);
    state.posts.push(...result.posts);
    state.nextCursor = result.nextCursor;
    renderPosts();
    renderHomeFeed();
  } catch (error) {
    if (reset) {
      list.innerHTML = `<div class="panel empty">${escapeHtml(error.message)}</div>`;
      $('#home-feed').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    }
  }
}

$('#load-more').onclick = () => loadPosts(false);

function renderPosts() {
  const list = $('#feed-list');
  if (!state.posts.length) {
    list.innerHTML = '<div class="panel empty">还没有动态，来发布第一条养护记录吧。</div>';
    $('#load-more').hidden = true;
    return;
  }
  list.replaceChildren(...state.posts.map(renderPost));
  $('#load-more').hidden = !state.nextCursor;
}

function renderPost(post) {
  const card = document.createElement('article');
  card.className = 'panel post-card';
  const copy = document.createElement('div');
  copy.className = 'post-copy';
  copy.innerHTML = `<div class="post-head"><div class="author"><span class="author-avatar">${speciesIcon(post.pet.species)}</span><div><b>${escapeHtml(post.author.displayName)} ${roleTag(post.author.role)}</b><small>${escapeHtml(post.pet.name)} · ${escapeHtml(post.pet.breed || speciesLabel(post.pet.species))}</small></div></div><div><span class="phase-tag ${post.phase}">${post.phase === 'before' ? '养护前' : '养护后'}</span><div class="post-menu"></div></div></div><p class="post-time">${formatDateTime(post.createdAt)}${post.updatedAt !== post.createdAt ? ' · 已编辑' : ''}</p>`;
  if (post.body) {
    const body = document.createElement('p');
    body.className = 'post-body';
    body.textContent = post.body;
    copy.append(body);
  }
  if (post.status === 'hidden') {
    const hidden = document.createElement('p');
    hidden.className = 'hidden-note';
    hidden.textContent = `该内容已隐藏${post.moderationReason ? `：${post.moderationReason}` : ''}`;
    copy.append(hidden);
  }
  card.append(copy);
  const menu = $('.post-menu', copy);
  if (post.canEdit) menu.append(actionButton('编辑', () => openComposer(post)));
  if (post.canModerate) menu.append(actionButton(post.status === 'hidden' ? '恢复' : '隐藏', () => moderatePost(post)));
  if (post.canDelete) menu.append(actionButton('删除', () => deletePost(post)));
  if (post.images.length) {
    const gallery = document.createElement('div');
    gallery.className = `post-images${post.images.length === 1 ? ' one' : ''}`;
    post.images.forEach((image, index) => {
      const img = document.createElement('img');
      img.src = image.url;
      img.alt = `${post.pet.name}的${post.phase === 'before' ? '养护前' : '养护后'}图片 ${index + 1}`;
      img.loading = 'lazy';
      img.onclick = () => window.open(image.url, '_blank', 'noopener');
      gallery.append(img);
    });
    card.append(gallery);
  }
  const comments = document.createElement('div');
  comments.className = 'comments';
  const toggle = document.createElement('button');
  toggle.className = 'comment-toggle';
  toggle.textContent = `💬 ${post.commentCount} 条评论`;
  const commentList = document.createElement('div');
  commentList.className = 'comment-list';
  commentList.hidden = true;
  toggle.onclick = async () => {
    commentList.hidden = !commentList.hidden;
    if (!commentList.hidden && !commentList.dataset.loaded) await loadComments(post, commentList, toggle);
  };
  comments.append(toggle, commentList);
  card.append(comments);
  return card;
}

function renderHomeFeed() {
  const container = $('#home-feed');
  const posts = state.posts.filter((post) => post.status === 'published').slice(0, 3);
  if (!posts.length) {
    container.innerHTML = '<p class="empty">还没有公开动态。</p>';
    return;
  }
  container.replaceChildren(...posts.map((post) => {
    const node = document.createElement('div');
    node.className = 'mini-post';
    node.innerHTML = post.images[0] ? `<img class="mini-thumb" src="${post.images[0].url}" alt="">` : `<span class="mini-thumb" style="display:grid;place-items:center;font-size:25px">${speciesIcon(post.pet.species)}</span>`;
    const copy = document.createElement('div');
    copy.innerHTML = `<b>${escapeHtml(post.pet.name)} · ${post.phase === 'before' ? '养护前' : '养护后'}</b><small>${escapeHtml((post.body || '分享了图片').slice(0, 45))}</small>`;
    node.append(copy);
    return node;
  }));
}

async function deletePost(post) {
  if (!confirm('确定删除这条动态及其全部评论和图片吗？')) return;
  try {
    await api(`/api/posts/${post.id}`, { method: 'DELETE' });
    await loadPosts(true);
    showToast('动态已删除');
  } catch (error) {
    showToast(error.message);
  }
}

async function moderatePost(post) {
  const status = post.status === 'hidden' ? 'published' : 'hidden';
  const reason = status === 'hidden' ? prompt('请填写隐藏原因：') : '';
  if (status === 'hidden' && !reason) return;
  try {
    await api(`/api/posts/${post.id}/moderation`, { method: 'POST', body: JSON.stringify({ status, reason }) });
    await loadPosts(true);
    showToast(status === 'hidden' ? '动态已隐藏' : '动态已恢复');
  } catch (error) {
    showToast(error.message);
  }
}

async function loadComments(post, container, toggle) {
  container.innerHTML = '<p class="empty">正在加载评论…</p>';
  try {
    const result = await api(`/api/posts/${post.id}/comments`);
    container.dataset.loaded = 'true';
    renderComments(post, result.comments, container, toggle);
  } catch (error) {
    container.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function renderComments(post, comments, container, toggle) {
  container.textContent = '';
  if (!comments.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有评论。';
    container.append(empty);
  }
  comments.forEach((comment) => {
    const node = document.createElement('article');
    node.className = 'comment';
    node.innerHTML = `<div class="comment-head"><b>${escapeHtml(comment.author.displayName)}${roleSuffix(comment.author.role)}</b><div></div></div><p></p>`;
    $('p', node).textContent = comment.status === 'hidden' ? `该评论已隐藏${comment.moderationReason ? `：${comment.moderationReason}` : ''}` : comment.body;
    const actions = $('.comment-head div', node);
    if (comment.canEdit) actions.append(actionButton('编辑', async () => {
      const body = prompt('编辑评论：', comment.body);
      if (!body || body === comment.body) return;
      try {
        await api(`/api/comments/${comment.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
        delete container.dataset.loaded;
        await loadComments(post, container, toggle);
      } catch (error) { showToast(error.message); }
    }));
    if (comment.canModerate) actions.append(actionButton(comment.status === 'hidden' ? '恢复' : '隐藏', async () => {
      const status = comment.status === 'hidden' ? 'published' : 'hidden';
      const reason = status === 'hidden' ? prompt('请填写隐藏原因：') : '';
      if (status === 'hidden' && !reason) return;
      try {
        await api(`/api/comments/${comment.id}/moderation`, { method: 'POST', body: JSON.stringify({ status, reason }) });
        delete container.dataset.loaded;
        await loadComments(post, container, toggle);
      } catch (error) { showToast(error.message); }
    }));
    if (comment.canDelete) actions.append(actionButton('删除', async () => {
      if (!confirm('确定删除这条评论吗？')) return;
      try {
        await api(`/api/comments/${comment.id}`, { method: 'DELETE' });
        post.commentCount = Math.max(0, post.commentCount - 1);
        delete container.dataset.loaded;
        await loadComments(post, container, toggle);
      } catch (error) { showToast(error.message); }
    }));
    container.append(node);
  });
  const form = document.createElement('form');
  form.className = 'comment-form';
  form.innerHTML = '<input maxlength="500" placeholder="写下你的评论…"><button class="primary-button" type="submit">评论</button>';
  form.dataset.requestId = crypto.randomUUID();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (form.dataset.submitting === 'true') return;
    if (!requireLogin()) return;
    const input = $('input', form);
    if (!input.value.trim()) return;
    const button = $('button[type="submit"]', form);
    form.dataset.submitting = 'true';
    input.disabled = true;
    button.disabled = true;
    button.textContent = '提交中…';
    try {
      await api(`/api/posts/${post.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: input.value, requestId: form.dataset.requestId })
      });
      post.commentCount += 1;
      toggle.textContent = `💬 ${post.commentCount} 条评论`;
      input.value = '';
      form.dataset.requestId = crypto.randomUUID();
      delete container.dataset.loaded;
      await loadComments(post, container, toggle);
    } catch (error) {
      showToast(error.message);
      form.dataset.submitting = 'false';
      input.disabled = false;
      button.disabled = false;
      button.textContent = '评论';
    }
  };
  container.append(form);
}

function setDateBounds() {
  const input = $('#booking-date');
  const today = new Date();
  input.min = localDate(today);
  input.max = localDate(new Date(today.getTime() + 30 * 864e5));
  if (!input.value) {
    let next = new Date(today.getTime() + 864e5);
    while ([0, 6].includes(next.getDay())) next = new Date(next.getTime() + 864e5);
    input.value = localDate(next);
  }
}

async function prepareBooking() {
  if (!state.user || !state.pets.length) {
    $('#booking-error').textContent = state.user ? '请先在宠物档案中添加宠物。' : '请先登录后预约。';
    $('#submit-booking').disabled = true;
    return;
  }
  $('#submit-booking').disabled = false;
  $('#booking-error').textContent = '';
  await loadSlots();
}

$('#booking-date').onchange = loadSlots;
let slotLoadVersion = 0;
async function loadSlots(preselect = '') {
  if (typeof preselect !== 'string') preselect = '';
  const date = $('#booking-date').value;
  const grid = $('#slot-grid');
  const loadVersion = ++slotLoadVersion;
  $('#booking-time').value = '';
  grid.textContent = '';
  if (!date) return;
  $('#slot-help').textContent = '正在查询…';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await api(`/api/appointments/availability?date=${encodeURIComponent(date)}`);
      if (loadVersion !== slotLoadVersion) return;
      result.slots.forEach((slot) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = slot.time;
        button.disabled = !slot.available && slot.time !== preselect;
        button.onclick = () => {
          $('#booking-time').value = slot.time;
          $$('#slot-grid button').forEach((item) => item.classList.toggle('selected', item === button));
        };
        grid.append(button);
        if (slot.time === preselect && !button.disabled) button.click();
      });
      $('#slot-help').textContent = '灰色时段不可预约';
      return;
    } catch (error) {
      if (loadVersion !== slotLoadVersion) return;
      if (error.status === 503 && attempt === 0) {
        $('#slot-help').textContent = '连接暂时不稳定，正在重试…';
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      $('#slot-help').textContent = error.message;
      return;
    }
  }
}

$('#booking-form').onsubmit = async (event) => {
  event.preventDefault();
  if (!requireLogin()) return;
  const form = event.currentTarget;
  $('#booking-error').textContent = '';
  if (!form.elements.time.value) {
    $('#booking-error').textContent = '请选择可预约时段';
    return;
  }
  const values = Object.fromEntries(new FormData(form));
  const payload = { ...values, requestId: crypto.randomUUID() };
  delete payload.time;
  payload.time = form.elements.time.value;
  if (state.editingAppointmentId) delete payload.requestId;
  const submit = $('#submit-booking');
  submit.disabled = true;
  try {
    await api(state.editingAppointmentId ? `/api/appointments/${state.editingAppointmentId}` : '/api/appointments', {
      method: state.editingAppointmentId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    showToast(state.editingAppointmentId ? '预约已更新' : '预约成功');
    resetBookingForm();
    await loadAppointments();
  } catch (error) {
    $('#booking-error').textContent = error.message;
    if (error.status === 409) await loadSlots(form.elements.time.value);
  } finally {
    submit.disabled = false;
  }
};

$('#cancel-booking-edit').onclick = resetBookingForm;
function resetBookingForm() {
  state.editingAppointmentId = null;
  const form = $('#booking-form');
  const contactName = form.elements.customerName.value;
  const phone = form.elements.customerPhone.value;
  form.reset();
  form.elements.customerName.value = contactName;
  form.elements.customerPhone.value = phone;
  $('#booking-form-title').textContent = '预约洗护';
  $('#submit-booking').textContent = '确认预约';
  $('#cancel-booking-edit').hidden = true;
  setDateBounds();
  syncPetUi();
  loadSlots();
}

async function loadAppointments() {
  if (!state.user) return;
  try {
    state.appointments = (await api('/api/appointments')).appointments;
    renderAppointments();
  } catch (error) {
    $('#appointment-list').innerHTML = `<div class="panel empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderAppointments() {
  const list = $('#appointment-list');
  if (!state.user) {
    list.innerHTML = '<div class="panel empty">登录后查看预约。</div>';
    return;
  }
  if (!state.appointments.length) {
    list.innerHTML = '<div class="panel empty">还没有洗护预约。</div>';
    return;
  }
  list.replaceChildren(...state.appointments.map((appointment) => {
    const card = document.createElement('article');
    card.className = 'appointment-card';
    const active = appointment.status === 'confirmed' && new Date(appointment.scheduledStart) > new Date();
    card.innerHTML = `<h3>${escapeHtml(serviceLabel(appointment.serviceCode))} <span class="tag">${appointment.status === 'cancelled' ? '已取消' : active ? '已确认' : '已结束'}</span></h3><p>${escapeHtml(appointment.petName)} · ${formatDateTime(appointment.scheduledStart)}</p><p>预约号 ${escapeHtml(appointment.referenceCode)}${appointment.notes ? ` · ${escapeHtml(appointment.notes)}` : ''}</p><div class="card-actions" ${active ? '' : 'hidden'}><button data-edit>修改</button><button class="danger" data-cancel>取消</button></div>`;
    $('[data-edit]', card)?.addEventListener('click', () => beginAppointmentEdit(appointment));
    $('[data-cancel]', card)?.addEventListener('click', () => cancelAppointment(appointment));
    return card;
  }));
}

function beginAppointmentEdit(appointment) {
  state.editingAppointmentId = appointment.id;
  const form = $('#booking-form');
  form.elements.petId.value = appointment.petId;
  form.elements.serviceCode.value = appointment.serviceCode;
  form.elements.date.value = localDate(new Date(appointment.scheduledStart));
  form.elements.customerName.value = appointment.customerName;
  form.elements.customerPhone.value = appointment.customerPhone;
  form.elements.notes.value = appointment.notes;
  $('#booking-form-title').textContent = '修改洗护预约';
  $('#submit-booking').textContent = '保存修改';
  $('#cancel-booking-edit').hidden = false;
  loadSlots(localTime(appointment.scheduledStart));
  form.scrollIntoView({ behavior: 'smooth' });
}

async function cancelAppointment(appointment) {
  if (!confirm(`确定取消 ${appointment.petName} 在 ${formatDateTime(appointment.scheduledStart)} 的预约吗？`)) return;
  try {
    await api(`/api/appointments/${appointment.id}/cancel`, { method: 'POST', body: '{}' });
    await loadAppointments();
    showToast('预约已取消');
  } catch (error) { showToast(error.message); }
}

$$('[data-admin-tab]').forEach((button) => {
  button.onclick = () => {
    $$('[data-admin-tab]').forEach((item) => item.classList.toggle('active', item === button));
    $$('[data-admin-section]').forEach((section) => { section.hidden = section.dataset.adminSection !== button.dataset.adminTab; });
  };
});

async function loadAdminPage() {
  if (!isAdmin()) return;
  await Promise.all([loadAdminUsers(), loadAdminPets(), loadAdminAppointments()]);
}

let adminUserSearchTimer;
$('#admin-user-search').oninput = (event) => {
  clearTimeout(adminUserSearchTimer);
  adminUserSearchTimer = setTimeout(() => loadAdminUsers(event.target.value.trim()), 250);
};

async function loadAdminUsers(query = '') {
  if (!isAdmin()) return;
  try {
    state.adminUsers = (await api(`/api/admin/users${query ? `?query=${encodeURIComponent(query)}` : ''}`)).users;
    renderAdminUsers();
    syncAdminOwnerOptions();
  } catch (error) {
    $('#admin-user-list').innerHTML = `<div class="panel empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderAdminUsers() {
  const list = $('#admin-user-list');
  if (!state.adminUsers.length) {
    list.innerHTML = '<div class="panel empty">没有匹配的用户。</div>';
    return;
  }
  list.replaceChildren(...state.adminUsers.map((user) => {
    const row = document.createElement('article');
    row.className = 'admin-row';
    row.innerHTML = `<div class="admin-row-main"><h3>${escapeHtml(user.displayName)} ${roleTag(user.role)}</h3><p>${escapeHtml(user.email)} · 注册于 ${formatDate(user.createdAt)}</p></div><div class="admin-row-actions"><select aria-label="${escapeHtml(user.displayName)}的角色"><option value="customer">顾客</option><option value="staff">员工</option><option value="admin">管理员</option></select></div>`;
    const select = $('select', row);
    select.value = user.role;
    select.disabled = user.id === state.user.id;
    select.onchange = async () => {
      const previous = user.role;
      select.disabled = true;
      try {
        await api(`/api/admin/users/${user.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
        user.role = select.value;
        showToast(`${user.displayName} 已调整为${roleLabel(user.role)}`);
        await loadAdminUsers($('#admin-user-search').value.trim());
      } catch (error) {
        select.value = previous;
        select.disabled = false;
        showToast(error.message);
      }
    };
    return row;
  }));
}

let adminPetSearchTimer;
$('#admin-pet-search').oninput = (event) => {
  clearTimeout(adminPetSearchTimer);
  adminPetSearchTimer = setTimeout(() => loadAdminPets(event.target.value.trim()), 250);
};

async function loadAdminPets(query = '') {
  if (!isAdmin()) return;
  try {
    state.adminPets = (await api(`/api/admin/pets${query ? `?query=${encodeURIComponent(query)}` : ''}`)).pets;
    renderAdminPets();
  } catch (error) {
    $('#admin-pet-list').innerHTML = `<div class="panel empty">${escapeHtml(error.message)}</div>`;
  }
}

function syncAdminOwnerOptions(selected = '') {
  const ownerSelect = $('#admin-pet-owner');
  ownerSelect.replaceChildren(...state.adminUsers.map((user) => option(user.id, `${user.displayName} · ${user.email}`)));
  if (selected) ownerSelect.value = selected;
}

$('#add-admin-pet').onclick = async () => {
  if (!state.adminUsers.length) await loadAdminUsers();
  state.editingAdminPetId = null;
  state.adminPetCreateRequestId = crypto.randomUUID();
  const form = $('#admin-pet-form');
  form.reset();
  syncAdminOwnerOptions();
  form.elements.ownerId.disabled = false;
  $('#admin-pet-form-title').textContent = '新建宠物';
  $('#admin-pet-error').textContent = '';
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

$('#close-admin-pet-form').onclick = closeAdminPetForm;
function closeAdminPetForm() {
  state.editingAdminPetId = null;
  state.adminPetCreateRequestId = null;
  $('#admin-pet-form').hidden = true;
  $('#admin-pet-error').textContent = '';
}

$('#admin-pet-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting === 'true') return;
  form.dataset.submitting = 'true';
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = { ...values, birthDate: values.birthDate || null, weightKg: values.weightKg ? Number(values.weightKg) : null };
  if (state.editingAdminPetId) {
    delete payload.ownerId;
  } else {
    payload.requestId = state.adminPetCreateRequestId || (state.adminPetCreateRequestId = crypto.randomUUID());
  }
  $('#admin-pet-error').textContent = '';
  try {
    await api(state.editingAdminPetId ? `/api/admin/pets/${state.editingAdminPetId}` : '/api/admin/pets', {
      method: state.editingAdminPetId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    showToast(state.editingAdminPetId ? '宠物档案已更新' : '宠物档案已创建');
    closeAdminPetForm();
    await Promise.all([loadAdminPets($('#admin-pet-search').value.trim()), loadPets()]);
  } catch (error) {
    $('#admin-pet-error').textContent = error.message;
  } finally {
    form.dataset.submitting = 'false';
    submit.disabled = false;
  }
};

function renderAdminPets() {
  const list = $('#admin-pet-list');
  if (!state.adminPets.length) {
    list.innerHTML = '<div class="panel empty">没有匹配的宠物。</div>';
    return;
  }
  list.replaceChildren(...state.adminPets.map((pet) => {
    const row = document.createElement('article');
    row.className = 'admin-row';
    row.innerHTML = `<div class="admin-row-main"><h3>${speciesIcon(pet.species)} ${escapeHtml(pet.name)}</h3><p>${escapeHtml(pet.breed || speciesLabel(pet.species))}${pet.weightKg ? ` · ${pet.weightKg} kg` : ''} · 主人：${escapeHtml(pet.ownerName || '未知')}</p></div><div class="admin-row-actions"><button data-edit>编辑</button><button class="danger" data-delete>删除</button></div>`;
    $('[data-edit]', row).onclick = () => beginAdminPetEdit(pet);
    $('[data-delete]', row).onclick = () => deleteAdminPet(pet);
    return row;
  }));
}

function beginAdminPetEdit(pet) {
  state.editingAdminPetId = pet.id;
  state.adminPetCreateRequestId = null;
  const form = $('#admin-pet-form');
  syncAdminOwnerOptions(pet.ownerId);
  form.elements.ownerId.disabled = true;
  for (const name of ['name', 'species', 'breed', 'sex', 'birthDate', 'weightKg']) form.elements[name].value = pet[name] ?? '';
  $('#admin-pet-form-title').textContent = `编辑 ${pet.name}`;
  $('#admin-pet-error').textContent = '';
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteAdminPet(pet) {
  if (!confirm(`确定删除 ${pet.name} 的档案吗？存在预约或动态时无法删除。`)) return;
  try {
    await api(`/api/admin/pets/${pet.id}`, { method: 'DELETE' });
    await Promise.all([loadAdminPets($('#admin-pet-search').value.trim()), loadPets()]);
    showToast('宠物档案已删除');
  } catch (error) {
    showToast(error.message);
  }
}

$('#refresh-admin-appointments').onclick = loadAdminAppointments;
async function loadAdminAppointments() {
  if (!isAdmin()) return;
  try {
    state.adminAppointments = (await api('/api/admin/appointments')).appointments;
    renderAdminAppointments();
  } catch (error) {
    $('#admin-appointment-list').innerHTML = `<div class="panel empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderAdminAppointments() {
  const list = $('#admin-appointment-list');
  if (!state.adminAppointments.length) {
    list.innerHTML = '<div class="panel empty">当前没有预约。</div>';
    return;
  }
  list.replaceChildren(...state.adminAppointments.map((appointment) => {
    const row = document.createElement('article');
    const active = appointment.status === 'confirmed' && new Date(appointment.scheduledStart) > new Date();
    row.className = 'admin-row';
    row.innerHTML = `<div class="admin-row-main"><h3>${escapeHtml(serviceLabel(appointment.serviceCode))} · ${escapeHtml(appointment.petName)} <span class="tag">${appointment.status === 'cancelled' ? '已取消' : active ? '已确认' : '已结束'}</span></h3><p>${formatDateTime(appointment.scheduledStart)} · ${escapeHtml(appointment.ownerName || appointment.customerName)}${appointment.ownerEmail ? ` · ${escapeHtml(appointment.ownerEmail)}` : ''} · ${escapeHtml(appointment.customerPhone)}</p><p>预约号 ${escapeHtml(appointment.referenceCode)}${appointment.notes ? ` · ${escapeHtml(appointment.notes)}` : ''}</p></div><div class="admin-row-actions" ${active ? '' : 'hidden'}>${appointment.ownerId ? '<button data-edit>修改</button>' : ''}<button class="danger" data-cancel>取消</button></div>`;
    $('[data-edit]', row)?.addEventListener('click', () => beginAdminAppointmentEdit(appointment));
    $('[data-cancel]', row)?.addEventListener('click', () => cancelAdminAppointment(appointment));
    return row;
  }));
}

async function beginAdminAppointmentEdit(appointment) {
  state.editingAdminAppointmentId = appointment.id;
  const form = $('#admin-appointment-form');
  let availablePets = state.adminPets;
  if (!availablePets.some((pet) => pet.id === appointment.petId)) {
    try {
      availablePets = (await api('/api/admin/pets')).pets;
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  const pets = availablePets.filter((pet) => pet.ownerId === appointment.ownerId);
  form.elements.petId.replaceChildren(...pets.map((pet) => option(pet.id, `${speciesIcon(pet.species)} ${pet.name}`)));
  form.elements.petId.value = appointment.petId;
  form.elements.date.value = localDate(new Date(appointment.scheduledStart));
  form.elements.time.value = localTime(appointment.scheduledStart);
  form.elements.serviceCode.value = appointment.serviceCode;
  form.elements.customerName.value = appointment.customerName;
  form.elements.customerPhone.value = appointment.customerPhone;
  form.elements.notes.value = appointment.notes;
  setAdminAppointmentDateBounds(form.elements.date);
  $('#admin-appointment-owner').textContent = `${appointment.ownerName || appointment.customerName} · ${appointment.ownerEmail || appointment.customerPhone}`;
  $('#admin-appointment-error').textContent = '';
  $('#admin-appointment-dialog').showModal();
}

$('#close-admin-appointment').onclick = () => $('#admin-appointment-dialog').close();
$('#admin-appointment-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form));
  $('#admin-appointment-error').textContent = '';
  try {
    await api(`/api/admin/appointments/${state.editingAdminAppointmentId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    $('#admin-appointment-dialog').close();
    await Promise.all([loadAdminAppointments(), loadAppointments()]);
    showToast('预约已更新');
  } catch (error) {
    $('#admin-appointment-error').textContent = error.message;
  }
};

async function cancelAdminAppointment(appointment) {
  if (!confirm(`确定取消 ${appointment.petName} 在 ${formatDateTime(appointment.scheduledStart)} 的预约吗？`)) return;
  try {
    await api(`/api/admin/appointments/${appointment.id}/cancel`, { method: 'POST', body: '{}' });
    await Promise.all([loadAdminAppointments(), loadAppointments()]);
    showToast('预约已取消');
  } catch (error) {
    showToast(error.message);
  }
}

function setAdminAppointmentDateBounds(input) {
  const today = new Date();
  input.min = localDate(today);
  input.max = localDate(new Date(today.getTime() + 30 * 864e5));
}

function actionButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = handler;
  return button;
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function speciesIcon(species) { return species === 'dog' ? '🐶' : species === 'cat' ? '🐱' : '🐾'; }
function speciesLabel(species) { return species === 'dog' ? '狗狗' : species === 'cat' ? '猫咪' : '其他宠物'; }
function serviceLabel(code) { return ({ basic_wash: '基础洗护', deep_care: '深度护理', wash_and_style: '洗护造型' })[code] || code; }
function hasStaffAccess(role) { return role === 'staff' || role === 'admin'; }
function isAdmin() { return state.user?.role === 'admin'; }
function roleLabel(role) { return ({ customer: '顾客', staff: '员工', admin: '管理员' })[role] || role; }
function roleSuffix(role) { return role === 'customer' ? '' : ` · ${roleLabel(role)}`; }
function roleTag(role) { return role === 'customer' ? '' : `<span class="role-tag ${role === 'admin' ? 'admin' : ''}">${roleLabel(role)}</span>`; }
function localDate(date) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date); }
function localTime(value) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)); }
function formatDate(value) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value)); }
function formatDateTime(value) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)); }
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = String(value ?? ''); return node.innerHTML; }

initialize();
