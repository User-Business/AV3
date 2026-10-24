import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ator } from '../../domain/autorizacao.js';
import { ErroNaoAutenticado } from '../../domain/erros.js';
import type { AutenticacaoService, ClaimsToken } from '../../services/autenticacao.service.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: ClaimsToken;
    user: ClaimsToken;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo hook `autenticar`; os controllers repassam aos serviços. */
    ator?: Ator;
  }
  interface FastifyInstance {
    autenticar: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    emitirToken: (claims: ClaimsToken) => { token: string; tipo: 'Bearer'; expiraEm: string; usuario: string; papel: ClaimsToken['papel'] };
  }
}

interface Opcoes {
  segredo: string;
  expiraEm: string;
  servico: AutenticacaoService;
}

/**
 * JWT (stateless) com @fastify/jwt.
 *  - `emitirToken`: assina as claims devolvidas pelo AutenticacaoService.
 *  - `autenticar`: preHandler que valida o header "Authorization: Bearer ...",
 *    confere revogação/usuário ativo e injeta `request.ator`.
 */
export const pluginAutenticacao = fp<Opcoes>(
  async (app, opcoes) => {
    await app.register(fastifyJwt, {
      secret: opcoes.segredo,
      sign: { expiresIn: opcoes.expiraEm, algorithm: 'HS256' },
      verify: { algorithms: ['HS256'] },
    });

    app.decorateRequest('ator', undefined);

    app.decorate('emitirToken', (claims: ClaimsToken) => {
      const token = app.jwt.sign({ sub: claims.sub, usuario: claims.usuario, papel: claims.papel, tv: claims.tv });
      const { exp } = app.jwt.decode<{ exp: number }>(token)!;
      return {
        token,
        tipo: 'Bearer' as const,
        expiraEm: new Date(exp * 1000).toISOString(),
        usuario: claims.usuario,
        papel: claims.papel,
      };
    });

    app.decorate('autenticar', async (request: FastifyRequest) => {
      let claims: ClaimsToken;
      try {
        claims = await request.jwtVerify<ClaimsToken>();
      } catch {
        throw new ErroNaoAutenticado('Token ausente, inválido ou expirado');
      }
      request.ator = await opcoes.servico.validarSessao(claims);
    });
  },
  { name: 'greencode-autenticacao' },
);
