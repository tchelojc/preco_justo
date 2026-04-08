/**
 * =============================================================
 * PREÇO JUSTO — Frontend App (colaborativo)
 * =============================================================
 * Comunicação direta com o backend GAS (colaborativo)
 * Usuários enviam preços com foto → dados salvos no Drive
 * =============================================================
 */

// ========== CONFIGURAÇÃO ==========
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbwJNABfam_giz6aSyWZ3Cd-iKjkLAXQEE-mMZvBiWS-t21R88SGNYTr4RnJApcdEDwEIA/exec';
const IMGBB_API_KEY = '2597fbdd4014975ed01d56ee9a6b404d'; // sua chave

// ========== ESTADO GLOBAL ==========
let STATE = {
  produtos:       [],
  mercados:       [],
  produtoAtual:   null,
  resultados:     [],
  carregando:     false,
  ultimaAtualizacao: null
};

// ========== FUNÇÕES DE COMUNICAÇÃO COM O BACKEND ==========

/**
 * Requisição GET para o backend
 */
async function fetchGET(action, params = {}) {
  const query = new URLSearchParams({ action, ...params }).toString();
  const url = `${BACKEND_URL}?${query}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.erro) throw new Error(json.erro);
  return json;
}

/**
 * Requisição POST para o backend (envio de preço)
 */
async function fetchPOST(acao, dados) {
  const formData = new URLSearchParams();
  formData.append('data', JSON.stringify({ acao, dados }));
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString()
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro no servidor');
  return json;
}

// ========== FUNÇÕES DE NEGÓCIO (BACKEND) ==========

async function listarProdutos() {
  return await fetchGET('produtos');
}

async function listarMercados() {
  return await fetchGET('mercados');
}

async function obterPrecoDestaque(produtoId, mercadoId) {
  return await fetchGET('preco_destaque', { produto: produtoId, mercado: mercadoId });
}

async function salvarPreco(dados) {
  return await fetchPOST('enviar_preco', dados);
}

// ========== FUNÇÕES DE UPLOAD DE IMAGEM (ImgBB) ==========

/**
 * Comprime uma imagem (base64) e retorna via callback
 */
function compressImage(base64, maxWidth = 800, quality = 0.7, callback) {
  const img = new Image();
  img.onload = () => {
    let width = img.width;
    let height = img.height;
    if (width > maxWidth) {
      height = (height * maxWidth) / width;
      width = maxWidth;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    callback(canvas.toDataURL('image/jpeg', quality));
  };
  img.src = base64;
}

/**
 * Faz upload de uma imagem para ImgBB e retorna a URL pública
 */
async function uploadParaImgBB(base64Image) {
  let imageData = base64Image;
  if (base64Image.includes(',')) {
    imageData = base64Image.split(',')[1];
  }
  const formData = new FormData();
  formData.append('key', IMGBB_API_KEY);
  formData.append('image', imageData);
  const response = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: formData
  });
  const result = await response.json();
  if (result.success) {
    return result.data.url;
  } else {
    throw new Error(result.error?.message || 'Falha no upload');
  }
}

/**
 * Upload de arquivo de imagem (File) para ImgBB
 */
async function uploadImageToHost(file, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('Imagem muito grande. Máximo 5MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      compressImage(ev.target.result, maxWidth, quality, async (compressedBase64) => {
        try {
          const url = await uploadParaImgBB(compressedBase64);
          resolve(url);
        } catch (err) {
          reject(err);
        }
      });
    };
    reader.onerror = () => reject(new Error('Erro ao ler o arquivo'));
    reader.readAsDataURL(file);
  });
}

// ========== FUNÇÕES DE SESSÃO (opcional, para identificar usuário) ==========
function obterSessao() {
  const raw = localStorage.getItem('precojusto_sessao');
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s.autenticado || !s.expira || Date.now() > s.expira) {
      localStorage.removeItem('precojusto_sessao');
      return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

function salvarSessao(email, nome) {
  const sess = {
    email: email,
    nome: nome,
    autenticado: true,
    expira: Date.now() + 8 * 3600000
  };
  localStorage.setItem('precojusto_sessao', JSON.stringify(sess));
}

function limparSessao() {
  localStorage.removeItem('precojusto_sessao');
}

// ========== LÓGICA PRINCIPAL DO APP ==========

document.addEventListener('DOMContentLoaded', () => {
  inicializar();

  document.getElementById('btn-buscar').addEventListener('click', () => {
    const id = document.getElementById('select-produto').value;
    if (id) buscarPrecos(id);
  });

  document.getElementById('select-produto').addEventListener('change', (e) => {
    if (e.target.value) buscarPrecos(e.target.value);
  });

  document.getElementById('btn-atualizar').addEventListener('click', () => {
    if (STATE.produtoAtual) buscarPrecos(STATE.produtoAtual, true);
  });
});

async function inicializar() {
  mostrarLoading('Carregando catálogo de produtos…');
  try {
    const [produtos, mercados] = await Promise.all([
      listarProdutos(),
      listarMercados()
    ]);

    STATE.produtos = produtos;
    STATE.mercados = mercados.filter(m => m.ativo !== false);

    popularSelectProdutos(produtos);
    renderizarMercadosChip(STATE.mercados);

    if (produtos.length > 0) {
      document.getElementById('select-produto').value = produtos[0].id;
      await buscarPrecos(produtos[0].id);
    }
  } catch (err) {
    console.error(err);
    mostrarErro('Erro ao inicializar. Verifique se o backend está ativo.', err);
  }
}

async function buscarPrecos(produtoId) {
  STATE.produtoAtual = produtoId;
  const produto = STATE.produtos.find(p => p.id === produtoId);

  mostrarLoading(`Buscando preços de ${produto?.nome_canonico || produtoId}…`);

  try {
    const promessas = STATE.mercados.map(async mercado => {
      const precoDestaque = await obterPrecoDestaque(produtoId, mercado.id);
      if (!precoDestaque) return null;
      return {
        mercado_id: mercado.id,
        mercado_nome: mercado.nome,
        mercado_logo: mercado.logo,
        mercado_cor: mercado.cor,
        resultados: [{
          preco: precoDestaque.preco,
          nome: produto.nome_canonico,
          preco_por_unidade: null,
          fotoUrl: precoDestaque.fotoUrl,
          dataHora: precoDestaque.dataHora,
          url: null
        }]
      };
    });

    let resultados = (await Promise.all(promessas)).filter(r => r !== null);
    resultados.sort((a, b) => a.resultados[0].preco - b.resultados[0].preco);

    const datas = resultados.flatMap(r => r.resultados.map(rr => new Date(rr.dataHora)));
    if (datas.length) {
      const maisRecente = new Date(Math.max(...datas));
      STATE.ultimaAtualizacao = maisRecente.toISOString();
    } else {
      STATE.ultimaAtualizacao = null;
    }

    STATE.resultados = resultados;
    renderizarResultados(produto, { resultados });
  } catch (err) {
    console.error(err);
    mostrarErro('Não foi possível buscar os preços. Tente novamente.', err);
  }
}

function popularSelectProdutos(produtos) {
  const select = document.getElementById('select-produto');
  select.innerHTML = '';
  const categorias = [...new Set(produtos.map(p => p.categoria))];
  for (const cat of categorias) {
    const group = document.createElement('optgroup');
    group.label = cat;
    produtos
      .filter(p => p.categoria === cat)
      .forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.nome_canonico} ${p.embalagem}`;
        group.appendChild(opt);
      });
    select.appendChild(group);
  }
}

function renderizarMercadosChip(mercados) {
  const container = document.getElementById('chips-mercados');
  container.innerHTML = '';
  mercados.forEach(m => {
    const chip = document.createElement('span');
    chip.className = 'chip-mercado';
    chip.style.borderColor = m.cor;
    chip.textContent = `${m.logo} ${m.nome}`;
    container.appendChild(chip);
  });
}

function renderizarResultados(produto, dados) {
  const container = document.getElementById('resultados');
  const resultados = dados.resultados || [];

  if (resultados.length === 0) {
    container.innerHTML = `
      <div class="estado-vazio">
        <span class="icone-vazio">🔍</span>
        <p>Nenhum preço encontrado para este produto ainda.</p>
        <p class="hint">Seja o primeiro a ajudar! Envie um preço com foto da etiqueta.</p>
      </div>`;
    return;
  }

  const melhorPreco = resultados[0]?.resultados[0]?.preco;

  let html = `
    <div class="resumo-header">
      <h2 class="produto-titulo">${produto?.nome_canonico} <span class="embalagem">${produto?.embalagem}</span></h2>
      <div class="badges">
        <span class="badge-mercados">${resultados.length} mercados com preço</span>
        ${STATE.ultimaAtualizacao ? `<span class="badge-hora">📅 ${formatarData(STATE.ultimaAtualizacao)}</span>` : ''}
      </div>
    </div>
    <div class="grade-resultados">`;

  resultados.forEach((item, idx) => {
    const top = item.resultados[0];
    if (!top) return;
    const ehMelhor = idx === 0;
    const economiaReais = melhorPreco ? (top.preco - melhorPreco).toFixed(2) : null;
    const dataPreco = top.dataHora ? formatarData(top.dataHora) : 'data desconhecida';

    html += `
      <div class="card-mercado ${ehMelhor ? 'card-melhor' : ''}" style="--cor-mercado: ${item.mercado_cor}">
        ${ehMelhor ? '<div class="ribbon-melhor">🏆 Melhor Preço</div>' : ''}
        <div class="card-topo">
          <span class="logo-mercado">${item.mercado_logo}</span>
          <div class="nome-mercado">${item.mercado_nome}</div>
          ${economiaReais ? `<div class="economia-badge">+R$ ${economiaReais} a mais</div>` : ''}
        </div>
        <div class="card-corpo">
          <div class="nome-produto-site">${top.nome}</div>
          <div class="preco-grande">R$ ${top.preco.toFixed(2).replace('.', ',')}</div>
          <div class="small-text" style="margin-top: 6px;">
            <i class="far fa-clock"></i> Atualizado em ${dataPreco}
          </div>
          ${top.fotoUrl ? `<a href="${top.fotoUrl}" target="_blank" class="link-foto" style="font-size:0.7rem;">📸 Ver comprovante</a>` : ''}
        </div>
        <div class="card-footer" style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px;">
          <button class="btn-ajudar" data-produto="${produto.id}" data-mercado="${item.mercado_id}" data-mercado-nome="${item.mercado_nome}">
            <i class="fas fa-camera"></i> Ajudar com preço
          </button>
        </div>
      </div>`;
  });

  html += '</div>';
  container.innerHTML = html;

  document.querySelectorAll('.btn-ajudar').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const produtoId = btn.dataset.produto;
      const mercadoId = btn.dataset.mercado;
      const mercadoNome = btn.dataset.mercadoNome;
      abrirModalEnvioPreco(produtoId, mercadoId, mercadoNome);
    });
  });

  requestAnimationFrame(() => {
    document.querySelectorAll('.card-mercado').forEach((card, i) => {
      card.style.animationDelay = `${i * 60}ms`;
      card.classList.add('card-entrada');
    });
  });
}

async function abrirModalEnvioPreco(produtoId, mercadoId, mercadoNome) {
  // Identificação do usuário (opcional, pode ser anônimo)
  let usuarioId = 'anonimo';
  let usuarioNome = 'Anônimo';
  const sess = obterSessao();
  if (sess) {
    usuarioId = sess.email;
    usuarioNome = sess.nome;
  } else {
    const nome = prompt('Para colaborar, informe seu nome (ou clique em Cancelar para continuar anônimo):');
    if (nome && nome.trim()) {
      usuarioNome = nome.trim();
      salvarSessao(usuarioNome + '@anonimo', usuarioNome);
      usuarioId = usuarioNome + '@anonimo';
    }
  }

  const precoStr = prompt(`Informe o preço do ${produtoId.replace(/_/g,' ')} no ${mercadoNome} (ex: 4,99):`);
  if (!precoStr) return;
  const precoNum = parseFloat(precoStr.replace(',', '.'));
  if (isNaN(precoNum)) {
    alert('Preço inválido.');
    return;
  }

  // Solicitar foto
  const inputFoto = document.createElement('input');
  inputFoto.type = 'file';
  inputFoto.accept = 'image/*';
  inputFoto.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Imagem muito grande. Máximo 5MB.');
      return;
    }
    mostrarLoading('Enviando foto e preço...');
    try {
      const imageUrl = await uploadImageToHost(file, 800, 0.7);
      const dadosEnvio = {
        produtoId,
        mercadoId,
        preco: precoNum,
        fotoUrl: imageUrl,
        usuarioId,
        usuarioNome
      };
      const resultado = await salvarPreco(dadosEnvio);
      if (resultado && resultado.ok) {
        alert(`Preço enviado com sucesso! Obrigado pela colaboração.`);
        if (STATE.produtoAtual === produtoId) {
          await buscarPrecos(produtoId);
        }
      } else {
        throw new Error(resultado?.erro || 'Erro desconhecido');
      }
    } catch (err) {
      console.error(err);
      alert('Erro ao enviar preço: ' + err.message);
    }
  };
  inputFoto.click();
}

function mostrarLoading(msg) {
  const container = document.getElementById('resultados');
  if (container) {
    container.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>${msg}</p>
      </div>`;
  }
}

function mostrarErro(msg, err) {
  console.error(err);
  const container = document.getElementById('resultados');
  if (container) {
    container.innerHTML = `
      <div class="estado-erro">
        <span class="icone-erro">⚠️</span>
        <p>${msg}</p>
        <p class="detalhe-erro">${err?.message || ''}</p>
      </div>`;
  }
}

function formatarData(isoString) {
  try {
    return new Date(isoString).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) { return isoString; }
}
