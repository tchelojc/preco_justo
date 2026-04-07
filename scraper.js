/**
 * =============================================================
 * COMPARADOR RJ - SCRAPER ENGINE
 * Executado pelo GitHub Actions a cada 6 horas via cron job.
 * Salva os resultados como JSON no repositório.
 * =============================================================
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Carregar configurações ──────────────────────────────────
const MERCADOS = JSON.parse(readFileSync(path.join(ROOT, 'dados/mercados_rj.json'), 'utf8'));
const PRODUTOS  = JSON.parse(readFileSync(path.join(ROOT, 'dados/produtos_base.json'), 'utf8'));

// Headers para simular browser real
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache'
};

// ─── Utilitários ─────────────────────────────────────────────

/**
 * Extrai o preço por unidade padrão (R$/kg ou R$/L) a partir do nome e preço.
 */
function calcularPrecoPorUnidade(nome, preco) {
  const padroes = [
    { regex: /(\d+(?:[.,]\d+)?)\s*kg/i,  multiplicador: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*g\b/i,  multiplicador: 0.001 },
    { regex: /(\d+(?:[.,]\d+)?)\s*litros?/i, multiplicador: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*l\b/i,  multiplicador: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*ml/i,   multiplicador: 0.001 },
  ];

  for (const { regex, multiplicador } of padroes) {
    const m = nome.match(regex);
    if (m) {
      const qtd = parseFloat(m[1].replace(',', '.')) * multiplicador;
      if (qtd > 0) return +(preco / qtd).toFixed(2);
    }
  }
  return null; // sem unidade detectável
}

/**
 * Verifica se o nome do produto bate com as palavras-chave do produto alvo.
 * Usa lógica de score para evitar falsos positivos.
 */
function bateProduto(nomeSite, produtoAlvo) {
  const nomeLower = normalizarTexto(nomeSite);
  let score = 0;
  for (const palavra of produtoAlvo.palavras_chave) {
    if (nomeLower.includes(normalizarTexto(palavra))) score++;
  }
  return score >= 1;
}

function normalizarTexto(txt) {
  return (txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function parsearPreco(txt) {
  if (!txt) return null;
  const match = txt.replace(/\s/g, '').match(/(\d+[.,]\d{2})/);
  if (!match) return null;
  return parseFloat(match[1].replace(',', '.'));
}

// ─── Estratégias de Extração ─────────────────────────────────

/**
 * Estratégia 1: JSON-LD (mais confiável, padrão VTEX/Shopify)
 */
function extrairDeJsonLD(html, produtoAlvo) {
  const resultados = [];
  const matches = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];

  for (const match of matches) {
    try {
      const inner = match.replace(/<script[^>]*>|<\/script>/gi, '').trim();
      const json = JSON.parse(inner);

      const items = [];
      if (Array.isArray(json)) items.push(...json);
      else if (json['@graph']) items.push(...json['@graph']);
      else items.push(json);

      for (const item of items) {
        const tipo = item['@type'] || '';
        if (!['Product', 'Offer', 'ItemList'].includes(tipo) && !item.name) continue;

        const nome  = item.name || '';
        const gtin  = item.gtin || item.gtin13 || item.gtin8 || item.gtin14 || '';
        const url   = item.url || item['@id'] || '';
        let preco   = null;

        if (item.offers) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          preco = parseFloat(offer.price || offer.lowPrice || 0);
        }

        if (!nome || !preco || !bateProduto(nome, produtoAlvo)) continue;

        resultados.push({
          nome,
          preco: +preco.toFixed(2),
          preco_por_unidade: calcularPrecoPorUnidade(nome, preco),
          gtin,
          url,
          fonte: 'json_ld'
        });
      }
    } catch (_) { /* JSON mal-formado, ignora */ }
  }
  return resultados;
}

/**
 * Estratégia 2: Seletores CSS do DOM (fallback para sites sem JSON-LD limpo)
 */
function extrairPorDOM(html, mercado, produtoAlvo) {
  const resultados = [];
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const containers = doc.querySelectorAll(mercado.container_produto);
  containers.forEach(el => {
    const nome  = el.querySelector('[class*="name"],[class*="title"],[itemprop="name"]')?.textContent?.trim() || '';
    const precoTxt = el.querySelector('[class*="price"],[class*="preco"],[itemprop="price"]')?.textContent?.trim() || '';
    const preco = parsearPreco(precoTxt);
    const url   = el.querySelector('a')?.href || '';

    if (!nome || !preco || !bateProduto(nome, produtoAlvo)) return;

    resultados.push({
      nome,
      preco: +preco.toFixed(2),
      preco_por_unidade: calcularPrecoPorUnidade(nome, preco),
      gtin: '',
      url,
      fonte: 'dom'
    });
  });

  return resultados;
}

// ─── Scraper principal ───────────────────────────────────────

async function rasparMercadoProduto(mercado, produto) {
  const termo = encodeURIComponent(produto.palavras_chave[0]);
  const url   = mercado.base_url + mercado.busca_url_template.replace(/\{TERMO\}/g, termo);

  console.log(`  → [${mercado.nome}] ${produto.nome_canonico} — ${url}`);

  let html = '';
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000) // 15s timeout
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.warn(`    ✗ Fetch falhou: ${err.message}`);
    return [];
  }

  // Tenta JSON-LD primeiro; se não retornar nada, usa DOM
  let resultados = extrairDeJsonLD(html, produto);
  if (resultados.length === 0 && !mercado.json_ld_esperado) {
    resultados = extrairPorDOM(html, mercado, produto);
  }

  // Ordena por menor preço
  resultados.sort((a, b) => (a.preco_por_unidade || a.preco) - (b.preco_por_unidade || b.preco));

  // Retorna apenas top 5 por produto/mercado
  return resultados.slice(0, 5);
}

async function salvarCache(mercado, produto, resultados) {
  const dir = path.join(ROOT, 'dados/precos_cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const arquivo = path.join(dir, `${mercado.id}_${produto.id}.json`);
  const payload = {
    data_hora:       new Date().toISOString(),
    mercado_id:      mercado.id,
    mercado_nome:    mercado.nome,
    mercado_cor:     mercado.cor,
    mercado_logo:    mercado.logo,
    produto_id:      produto.id,
    produto_nome:    produto.nome_canonico,
    produto_categoria: produto.categoria,
    resultados
  };

  writeFileSync(arquivo, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`    ✓ Salvo: ${mercado.id}_${produto.id}.json (${resultados.length} items)`);
}

// ─── Entry point ─────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Comparador RJ — Scraper iniciado em ${new Date().toLocaleString('pt-BR')}\n`);

  const mercadosAtivos = MERCADOS.filter(m => m.ativo);
  let total = 0;

  for (const mercado of mercadosAtivos) {
    console.log(`\n📦 Mercado: ${mercado.nome}`);

    for (const produto of PRODUTOS) {
      const resultados = await rasparMercadoProduto(mercado, produto);
      await salvarCache(mercado, produto, resultados);
      total += resultados.length;

      // Pausa educada entre requests (evita ban)
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
    }
  }

  // Gera índice global para o frontend consultar
  const indice = {
    atualizado_em: new Date().toISOString(),
    mercados:      mercadosAtivos.map(m => m.id),
    produtos:      PRODUTOS.map(p => p.id),
    total_registros: total
  };

  writeFileSync(
    path.join(ROOT, 'dados/precos_cache/_indice.json'),
    JSON.stringify(indice, null, 2),
    'utf8'
  );

  console.log(`\n✅ Concluído! ${total} preços coletados.\n`);
}

main().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
