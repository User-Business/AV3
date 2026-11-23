import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { ParceiroAutenticado } from '../../domain/chave-api.js';
import type { ChaveApiService } from '../../services/chave-api.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo hook `autenticarParceiro` nas rotas da API pública. */
    parceiro?: ParceiroAutenticado;
  }
  interface FastifyInstance {
    autenticarParceiro: (request: FastifyRequest) => Promise<void>;
  }
}

export const CABECALHO_CHAVE_API = 'x-api-key';

/** Autenticação dos parceiros externos pelo cabeçalho X-API-Key. */
export const pluginChaveApi = fp<{ servico: ChaveApiService }>(
  async (app, opcoes) => {
    app.decorateRequest('parceiro', undefined);
    app.decorate('autenticarParceiro', async (request: FastifyRequest) => {
      const cabecalho = request.headers[CABECALHO_CHAVE_API];
      request.parceiro = await opcoes.servico.autenticar(Array.isArray(cabecalho) ? cabecalho[0] : cabecalho);
    });
  },
  { name: 'greencode-chave-api' },
);
