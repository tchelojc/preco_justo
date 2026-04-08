/**
 * =============================================================
 * COMPARADOR RJ — Frontend App
 * Comunicação entre HTML ↔ GAS ↔ GitHub JSON
 * =============================================================
 *
 * ⚠️  CONFIGURAÇÃO: Substitua GAS_URL abaixo pela URL do seu
 *     deploy no Google Apps Script após publicar o Codigo.gs
 * =============================================================
 */

// Use EXATAMENTE a URL que você acabou de testar
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwb4Ko1d1A-PLXCdqN9THv8jNz3_LlQIdjgpUiesfSxc8KdLn3lecEASmoPiVxX9zefEQ/exec';

// Fallback direto no GitHub (caso GAS esteja fora ou em deploy novo)
const GITHUB_RAW = 'https://raw.githubusercontent.com/tchelojc/preco_justo/main/dados';

// ─── Estado Global ───────────────────────────────────────────
let STATE = {
  produtos:       [],
  mercados:       [],
  produtoAtual:   null,
  resultados:     [],
  carregando:     false,
  ultimaAtualizacao: null
};

// ─── Inicialização ───────────────────────────────────────────
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
      fetchGAS('produtos'),
      fetchGAS('mercados')
    ]);

    STATE.produtos = produtos;
    STATE.mercados = mercados;

    popularSelectProdutos(produtos);
    renderizarMercadosChip(mercados);

    // Busca o primeiro produto automaticamente
    if (produtos.length > 0) {
      document.getElementById('select-produto').value = produtos[0].id;
      await buscarPrecos(produtos[0].id);
    }
  } catch (err) {
    mostrarErro('Erro ao inicializar. Verifique se o GAS está configurado corretamente.', err);
  }
}

// ─── API Calls ───────────────────────────────────────────────

async function fetchGAS(action, params = {}) {
  const query = new URLSearchParams({ action, ...params }).toString();
  const url   = `${GAS_URL}?${query}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GAS retornou ${res.status}`);
  const json = await res.json();
  if (json.erro) throw new Error(json.erro);
  return json;
}

async function buscarPrecos(produtoId, forcar = false) {
  STATE.produtoAtual = produtoId;
  const produto = STATE.produtos.find(p => p.id === produtoId);

  mostrarLoading(`Buscando preços de ${produto?.nome_canonico || produtoId} nos mercados do Rio…`);

  try {
    const dados = await fetchGAS('precos', { produto: produtoId });
    STATE.resultados = dados.resultados || [];
    STATE.ultimaAtualizacao = dados.consultado_em;
    renderizarResultados(produto, dados);
  } catch (err) {
    mostrarErro('Não foi possível buscar os preços. Tente novamente.', err);
  }
}

// ─── Renderização ─────────────────────────────────────────────

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

  mercados.filter(m => m.ativo).forEach(m => {
    const chip = document.createElement('span');
    chip.className = 'chip-mercado';
    chip.style.borderColor = m.cor;
    chip.textContent = `${m.logo} ${m.nome}`;
    container.appendChild(chip);
  });
}

function renderizarResultados(produto, dados) {
  const container  = document.getElementById('resultados');
  const resultados = dados.resultados || [];

  if (resultados.length === 0) {
    container.innerHTML = `
      <div class="estado-vazio">
        <span class="icone-vazio">🔍</span>
        <p>Nenhum preço encontrado para este produto ainda.</p>
        <p class="hint">O scraper roda a cada 6 horas via GitHub Actions.</p>
      </div>`;
    return;
  }

  const melhorPreco = resultados[0]?.resultados[0]?.preco;

  let html = `
    <div class="resumo-header">
      <h2 class="produto-titulo">${produto?.nome_canonico} <span class="embalagem">${produto?.embalagem}</span></h2>
      <div class="badges">
        <span class="badge-mercados">${resultados.length} mercados comparados</span>
        ${STATE.ultimaAtualizacao ? `<span class="badge-hora">📅 ${formatarData(STATE.ultimaAtualizacao)}</span>` : ''}
      </div>
    </div>
    <div class="grade-resultados">`;

  resultados.forEach((item, idx) => {
    const top = item.resultados[0];
    if (!top) return;

    const ehMelhor   = idx === 0;
    const ehSegundo  = idx === 1;
    const economiaReais = melhorPreco ? (top.preco - melhorPreco).toFixed(2) : null;
    const economia   = economiaReais > 0 ? `+R$ ${economiaReais}` : null;

    html += `
      <div class="card-mercado ${ehMelhor ? 'card-melhor' : ''}" style="--cor-mercado: ${item.mercado_cor}">
        ${ehMelhor ? '<div class="ribbon-melhor">🏆 Melhor Preço</div>' : ''}
        <div class="card-topo">
          <span class="logo-mercado">${item.mercado_logo}</span>
          <div class="nome-mercado">${item.mercado_nome}</div>
          ${economia ? `<div class="economia-badge">+R$ ${economiaReais} a mais</div>` : ''}
        </div>
        <div class="card-corpo">
          <div class="nome-produto-site">${top.nome}</div>
          <div class="preco-grande">R$ ${top.preco.toFixed(2).replace('.', ',')}</div>
          ${top.preco_por_unidade ? `
            <div class="preco-unidade">
              R$ ${top.preco_por_unidade.toFixed(2).replace('.', ',')}/${produto?.unidade_medida || 'kg'}
            </div>` : ''}
          ${item.resultados.length > 1 ? `
            <details class="outras-opcoes">
              <summary>Ver ${item.resultados.length - 1} outra(s) opção(ões)</summary>
              <ul>
                ${item.resultados.slice(1).map(r => `
                  <li>
                    <span class="op-nome">${r.nome}</span>
                    <span class="op-preco">R$ ${r.preco.toFixed(2).replace('.', ',')}</span>
                  </li>`).join('')}
              </ul>
            </details>` : ''}
        </div>
        ${top.url ? `<a class="link-produto" href="${top.url}" target="_blank" rel="noopener">Ver no site →</a>` : ''}
      </div>`;
  });

  html += '</div>';
  container.innerHTML = html;

  // Animação de entrada nos cards
  requestAnimationFrame(() => {
    document.querySelectorAll('.card-mercado').forEach((card, i) => {
      card.style.animationDelay = `${i * 60}ms`;
      card.classList.add('card-entrada');
    });
  });
}

// ─── Estados de UI ────────────────────────────────────────────

function mostrarLoading(msg = 'Carregando…') {
  document.getElementById('resultados').innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>${msg}</p>
    </div>`;
}

function mostrarErro(msg, err) {
  console.error(err);
  document.getElementById('resultados').innerHTML = `
    <div class="estado-erro">
      <span class="icone-erro">⚠️</span>
      <p>${msg}</p>
      <p class="detalhe-erro">${err?.message || ''}</p>
    </div>`;
}

// ─── Formatação ───────────────────────────────────────────────

function formatarData(isoString) {
  try {
    return new Date(isoString).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) { return isoString; }
}
