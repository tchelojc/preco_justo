/**
 * =============================================================
 * PREÇO JUSTO — Frontend App (versão colaborativa)
 * =============================================================
 * Comunicação com o backend via integracao.js
 * Usuários enviam preços com foto → dados salvos no Drive
 * =============================================================
 */

// A URL do backend já está configurada dentro do integracao.js
// Não precisamos mais da constante GAS_URL aqui

// ─── Estado Global ───────────────────────────────────────────
let STATE = {
  produtos:       [],
  mercados:       [],
  produtoAtual:   null,
  resultados:     [],     // array no formato esperado pelo render
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

/**
 * Carrega produtos e mercados diretamente do backend (via integracao.js)
 */
async function inicializar() {
  mostrarLoading('Carregando catálogo de produtos…');
  try {
    // As funções listarProdutos e listarMercados vêm do integracao.js
    const [produtos, mercados] = await Promise.all([
      listarProdutos(),
      listarMercados()
    ]);

    STATE.produtos = produtos;
    STATE.mercados = mercados.filter(m => m.ativo !== false);

    popularSelectProdutos(produtos);
    renderizarMercadosChip(STATE.mercados);

    // Busca o primeiro produto automaticamente
    if (produtos.length > 0) {
      document.getElementById('select-produto').value = produtos[0].id;
      await buscarPrecos(produtos[0].id);
    }
  } catch (err) {
    console.error(err);
    mostrarErro('Erro ao inicializar. Verifique se o backend está ativo.', err);
  }
}

// ─── API Calls (via integracao.js) ───────────────────────────

/**
 * Busca os preços de um produto (para todos os mercados) e monta a estrutura
 * que o render espera: { resultados: [ { mercado_id, mercado_nome, mercado_logo, mercado_cor, resultados: [ { preco, nome, fotoUrl, dataHora } ] } ] }
 */
async function buscarPrecos(produtoId) {
  STATE.produtoAtual = produtoId;
  const produto = STATE.produtos.find(p => p.id === produtoId);

  mostrarLoading(`Buscando preços de ${produto?.nome_canonico || produtoId}…`);

  try {
    // Para cada mercado, obtém o preço destaque (se houver)
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
          preco_por_unidade: null, // pode ser calculado se tiver embalagem
          fotoUrl: precoDestaque.fotoUrl,
          dataHora: precoDestaque.dataHora,
          url: null // não temos URL do produto no site
        }]
      };
    });

    let resultados = (await Promise.all(promessas)).filter(r => r !== null);

    // Ordena por preço crescente
    resultados.sort((a, b) => a.resultados[0].preco - b.resultados[0].preco);

    // Atualiza a data da última atualização (mais recente entre os preços)
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

// ─── Renderização (mantida igual à original, com pequenos ajustes) ───

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

/**
 * Renderiza os cards de comparação
 * Agora inclui um botão "Ajudar com preço" (visível apenas em modos adequados)
 * e exibe a data da última atualização do preço.
 */
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

    const ehMelhor   = idx === 0;
    const economiaReais = melhorPreco ? (top.preco - melhorPreco).toFixed(2) : null;
    const economia   = economiaReais > 0 ? `+R$ ${economiaReais}` : null;
    const dataPreco = top.dataHora ? formatarData(top.dataHora) : 'data desconhecida';

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

  // Adiciona eventos para os botões de ajuda
  document.querySelectorAll('.btn-ajudar').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const produtoId = btn.dataset.produto;
      const mercadoId = btn.dataset.mercado;
      const mercadoNome = btn.dataset.mercadoNome;
      abrirModalEnvioPreco(produtoId, mercadoId, mercadoNome);
    });
  });

  // Animação de entrada
  requestAnimationFrame(() => {
    document.querySelectorAll('.card-mercado').forEach((card, i) => {
      card.style.animationDelay = `${i * 60}ms`;
      card.classList.add('card-entrada');
    });
  });
}

// ─── Modal para envio de preço (colaboração) ─────────────────

/**
 * Abre um modal simples (ou usa prompt) para o usuário informar o preço e a foto.
 * Utiliza as funções do integracao.js (uploadImageToHost, salvarPreco, etc.)
 */
async function abrirModalEnvioPreco(produtoId, mercadoId, mercadoNome) {
  // Verifica se o usuário está logado (opcional)
  const sess = obterSessao(); // função do integracao.js
  if (!sess) {
    if (confirm('Você não está logado. Deseja fazer login para colaborar?')) {
      window.location.href = 'marido_aluguel.html'; // ou página de login
    } else {
      // Permite envio anônimo? Vamos permitir, mas registrar como anônimo.
    }
  }

  const precoStr = prompt(`Informe o preço do ${produtoId.replace(/_/g,' ')} no ${mercadoNome} (ex: 4,99):`);
  if (!precoStr) return;
  const precoNum = parseFloat(precoStr.replace(',', '.'));
  if (isNaN(precoNum)) {
    alert('Preço inválido.');
    return;
  }

  // Solicitar foto da etiqueta
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
    mostrarLoading('Enviando foto...');
    try {
      // Usa a função do integracao.js para fazer upload para ImgBB
      const imageUrl = await uploadImageToHost(file, 800, 0.7);
      // Prepara dados para salvar no backend
      const dadosEnvio = {
        produtoId,
        mercadoId,
        preco: precoNum,
        fotoUrl: imageUrl,
        usuarioId: sess?.usuarioId || 'anonimo',
        usuarioNome: sess?.email || 'Anônimo'
      };
      const resultado = await salvarPreco(dadosEnvio);
      if (resultado && resultado.ok) {
        alert(`Preço enviado com sucesso! Obrigado pela colaboração.`);
        // Recarrega os preços do produto atual
        if (STATE.produtoAtual === produtoId) {
          await buscarPrecos(produtoId);
        }
      } else {
        throw new Error(resultado?.erro || 'Erro desconhecido');
      }
    } catch (err) {
      console.error(err);
      alert('Erro ao enviar preço: ' + err.message);
    } finally {
      // Fecha loading
      document.getElementById('resultados').innerHTML = ''; // limpa mensagem de loading
      await buscarPrecos(produtoId); // recarrega
    }
  };
  inputFoto.click();
}

// ─── Estados de UI (mantidos) ────────────────────────────────

function mostrarLoading(msg = 'Carregando…') {
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
