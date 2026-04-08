const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// ─── Configurações ─────────────────────────────────────────────
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DIR_DADOS = path.join(__dirname, 'dados');
const DIR_CACHE = path.join(DIR_DADOS, 'precos_cache');

// Garante que as pastas existem
if (!fs.existsSync(DIR_CACHE)) {
  fs.mkdirSync(DIR_CACHE, { recursive: true });
}

// ─── Função principal ──────────────────────────────────────────
async function main() {
  console.log('🚀 Iniciando scraper...\n');

  // Carrega os arquivos de configuração
  const mercados = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'mercados_rj.json'), 'utf8'));
  const produtos = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'produtos_base.json'), 'utf8'));

  const mercadosAtivos = mercados.filter(m => m.ativo);
  console.log(`📋 ${mercadosAtivos.length} mercados ativos`);
  console.log(`📦 ${produtos.length} produtos no catálogo\n`);

  const indice = {
    data_geracao: new Date().toISOString(),
    mercados: mercadosAtivos.map(m => m.id),
    produtos: produtos.map(p => p.id),
    total_arquivos: 0
  };

  let arquivosGerados = 0;

  // Para cada mercado ativo, busca cada produto (limitado aos primeiros 5 para teste)
  for (const mercado of mercadosAtivos) {
    console.log(`🏬 Processando ${mercado.nome}...`);

    for (const produto of produtos.slice(0, 5)) { // ⚠️ Apenas 5 produtos para teste rápido; remova o slice depois
      const termo = produto.palavras_chave[0];
      const urlBusca = `${mercado.base_url}${mercado.busca_url_template.replace('{TERMO}', encodeURIComponent(termo))}`;

      console.log(`   🔍 Buscando "${termo}" → ${urlBusca}`);

      try {
        const response = await fetch(urlBusca, {
          headers: { 'User-Agent': USER_AGENT }
        });

        if (!response.ok) {
          console.log(`   ⚠️ HTTP ${response.status} - ignorando`);
          continue;
        }

        const html = await response.text();
        const dom = new JSDOM(html);
        const doc = dom.window.document;

        let resultados = [];

        // Estratégia 1: JSON-LD
        const jsonLdScript = doc.querySelector('script[type="application/ld+json"]');
        if (jsonLdScript) {
          try {
            const data = JSON.parse(jsonLdScript.textContent);
            const items = data['@graph'] || [data];
            for (const item of items) {
              if (item['@type'] === 'Product' || item['@type'] === 'Offer') {
                const nome = item.name || '';
                const preco = parseFloat(item.offers?.price || item.price);
                if (preco && produto.palavras_chave.some(p => nome.toLowerCase().includes(p))) {
                  resultados.push({
                    nome,
                    preco,
                    preco_por_unidade: preco, // simplificado
                    url: item.url || urlBusca
                  });
                }
              }
            }
          } catch (e) {
            console.log(`   ⚠️ JSON-LD inválido`);
          }
        }

        // Estratégia 2: Fallback com seletores simples
        if (resultados.length === 0) {
          const elementos = doc.querySelectorAll(mercado.container_produto);
          elementos.forEach(el => {
            const nome = el.querySelector('h2, h3, .product-name, .name')?.textContent?.trim() || '';
            const precoTexto = el.querySelector('.price, .product-price, .valor')?.textContent?.replace(/[^\d,]/g, '')?.replace(',', '.');
            const preco = parseFloat(precoTexto);
            if (preco && produto.palavras_chave.some(p => nome.toLowerCase().includes(p))) {
              resultados.push({ nome, preco, preco_por_unidade: preco, url: '' });
            }
          });
        }

        // Salva o cache
        const cacheFile = path.join(DIR_CACHE, `${mercado.id}_${produto.id}.json`);
        const cacheData = {
          data_hora: new Date().toISOString(),
          mercado_id: mercado.id,
          mercado_nome: mercado.nome,
          mercado_logo: mercado.logo,
          mercado_cor: mercado.cor,
          produto_id: produto.id,
          resultados: resultados.slice(0, 3)
        };

        fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
        arquivosGerados++;
        console.log(`   ✅ ${resultados.length} resultados salvos`);

        // Aguarda 2 segundos entre requisições para não sobrecarregar
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (err) {
        console.log(`   ❌ Erro: ${err.message}`);
      }
    }
  }

  // Atualiza e salva o índice
  indice.total_arquivos = arquivosGerados;
  fs.writeFileSync(path.join(DIR_CACHE, '_indice.json'), JSON.stringify(indice, null, 2));

  console.log(`\n✨ Finalizado! ${arquivosGerados} arquivos de cache gerados.`);
}

main().catch(err => {
  console.error('💥 Erro fatal:', err);
  process.exit(1);
});
