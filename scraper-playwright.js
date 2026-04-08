const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR_DADOS = path.join(__dirname, 'dados');
const DIR_CACHE = path.join(DIR_DADOS, 'precos_cache');
if (!fs.existsSync(DIR_CACHE)) fs.mkdirSync(DIR_CACHE, { recursive: true });

// ========== UTILITÁRIOS ==========
function normalizarPreco(texto) {
  if (!texto) return null;
  const limpo = texto.replace(/[^\d,.-]/g, '').replace(',', '.');
  const num = parseFloat(limpo);
  return isNaN(num) ? null : num;
}

function calcularPrecoUnidade(preco, nome, embalagem) {
  const padroes = [
    { regex: /(\d+(?:[.,]\d+)?)\s*kg/i, mult: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*g\b/i, mult: 0.001 },
    { regex: /(\d+(?:[.,]\d+)?)\s*l\b/i, mult: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*ml/i, mult: 0.001 },
  ];
  for (const { regex, mult } of padroes) {
    const m = (nome + ' ' + embalagem).match(regex);
    if (m) {
      const qtd = parseFloat(m[1].replace(',', '.')) * mult;
      if (qtd > 0) return +(preco / qtd).toFixed(2);
    }
  }
  return null;
}

function normalizarTexto(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function bateProduto(nomeSite, produto) {
  const nomeNorm = normalizarTexto(nomeSite);
  return produto.palavras_chave.some(p => nomeNorm.includes(normalizarTexto(p)));
}

// ========== ESTRATÉGIAS POR PLATAFORMA ==========

async function rasparGuanabara(page, produto) {
  const termo = produto.palavras_chave[0];
  const url = `https://www.supermercadosguanabara.com.br/produtos?q=${encodeURIComponent(termo)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  
  // Aguarda os cards de produto (VTEX)
  await page.waitForSelector('.vtex-product-summary-2-x-container', { timeout: 10000 }).catch(() => {});
  
  const produtos = await page.$$eval('.vtex-product-summary-2-x-container', (cards) => {
    return cards.map(card => {
      const nome = card.querySelector('.vtex-product-summary-2-x-productBrand')?.innerText?.trim() || '';
      const precoEl = card.querySelector('.vtex-product-price-1-x-sellingPrice');
      const preco = precoEl?.innerText?.trim() || '';
      const link = card.querySelector('a')?.href || '';
      return { nome, preco, link };
    });
  });
  
  const resultados = [];
  for (const p of produtos) {
    if (!bateProduto(p.nome, produto)) continue;
    const preco = normalizarPreco(p.preco);
    if (!preco) continue;
    resultados.push({
      nome: p.nome,
      preco,
      preco_por_unidade: calcularPrecoUnidade(preco, p.nome, produto.embalagem),
      url: p.link,
    });
  }
  return resultados.slice(0, 3);
}

async function rasparMundial(page, produto) {
  const termo = produto.palavras_chave[0];
  const url = `https://www.sitemercado.com.br/supermercadosmundial/busca?q=${encodeURIComponent(termo)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  
  await page.waitForSelector('[data-product-id]', { timeout: 10000 }).catch(() => {});
  
  const produtos = await page.$$eval('[data-product-id]', (cards) => {
    return cards.map(card => {
      const nome = card.querySelector('.product-title')?.innerText?.trim() || '';
      const precoEl = card.querySelector('.price');
      const preco = precoEl?.innerText?.trim() || '';
      const link = card.querySelector('a')?.href || '';
      return { nome, preco, link };
    });
  });
  
  const resultados = [];
  for (const p of produtos) {
    if (!bateProduto(p.nome, produto)) continue;
    const preco = normalizarPreco(p.preco);
    if (!preco) continue;
    resultados.push({
      nome: p.nome,
      preco,
      preco_por_unidade: calcularPrecoUnidade(preco, p.nome, produto.embalagem),
      url: p.link,
    });
  }
  return resultados.slice(0, 3);
}

async function rasparHortifruti(page, produto) {
  const termo = produto.palavras_chave[0];
  const url = `https://www.hortifruti.com.br/busca?q=${encodeURIComponent(termo)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  
  await page.waitForSelector('.product-item', { timeout: 10000 }).catch(() => {});
  
  const produtos = await page.$$eval('.product-item', (cards) => {
    return cards.map(card => {
      const nome = card.querySelector('.product-name')?.innerText?.trim() || '';
      const precoEl = card.querySelector('.price, .product-price');
      const preco = precoEl?.innerText?.trim() || '';
      const link = card.querySelector('a')?.href || '';
      return { nome, preco, link };
    });
  });
  
  const resultados = [];
  for (const p of produtos) {
    if (!bateProduto(p.nome, produto)) continue;
    const preco = normalizarPreco(p.preco);
    if (!preco) continue;
    resultados.push({
      nome: p.nome,
      preco,
      preco_por_unidade: calcularPrecoUnidade(preco, p.nome, produto.embalagem),
      url: p.link,
    });
  }
  return resultados.slice(0, 3);
}

// ========== MAIN ==========
async function main() {
  console.log('🚀 Iniciando scraper com Playwright...\n');
  
  const mercados = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'mercados_rj.json'), 'utf8'));
  const produtos = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'produtos_base.json'), 'utf8'));
  const ativos = mercados.filter(m => m.ativo);
  
  console.log(`📋 ${ativos.length} mercados, ${produtos.length} produtos\n`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
  
  let arquivosGerados = 0;
  
  for (const mercado of ativos) {
    console.log(`\n🏬 ${mercado.nome}`);
    const page = await context.newPage();
    
    for (const produto of produtos) {
      process.stdout.write(`   🔍 ${produto.nome_canonico} ... `);
      let resultados = [];
      
      try {
        if (mercado.id === 'guanabara') {
          resultados = await rasparGuanabara(page, produto);
        } else if (mercado.id === 'mundial') {
          resultados = await rasparMundial(page, produto);
        } else if (mercado.id === 'hortifruti') {
          resultados = await rasparHortifruti(page, produto);
        }
        console.log(`✅ ${resultados.length}`);
      } catch (err) {
        console.log(`❌ ${err.message}`);
      }
      
      const cacheFile = path.join(DIR_CACHE, `${mercado.id}_${produto.id}.json`);
      fs.writeFileSync(cacheFile, JSON.stringify({
        data_hora: new Date().toISOString(),
        mercado_id: mercado.id,
        mercado_nome: mercado.nome,
        mercado_logo: mercado.logo,
        mercado_cor: mercado.cor,
        produto_id: produto.id,
        resultados,
      }, null, 2));
      
      arquivosGerados++;
      await page.waitForTimeout(1500); // intervalo educado
    }
    
    await page.close();
  }
  
  await browser.close();
  
  // Índice
  fs.writeFileSync(path.join(DIR_CACHE, '_indice.json'), JSON.stringify({
    atualizado_em: new Date().toISOString(),
    mercados: ativos.map(m => m.id),
    produtos: produtos.map(p => p.id),
    total_arquivos: arquivosGerados,
  }, null, 2));
  
  console.log(`\n✨ Concluído! ${arquivosGerados} arquivos gerados.`);
}

main().catch(err => { console.error('💥 Erro:', err); process.exit(1); });
