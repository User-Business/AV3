/**
 * Erros de domínio. Os serviços lançam apenas estes erros; a camada HTTP é quem
 * decide o status code (ver src/http/plugins/tratamento-erros.ts). Assim a mesma
 * lógica pode ser reaproveitada por CLI ou mensageria sem conhecer HTTP.
 */
export abstract class ErroDominio extends Error {
  abstract readonly codigo: string;

  constructor(
    mensagem: string,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = new.target.name;
  }
}

/** Dados de entrada inválidos (formato, faixa, campo obrigatório). */
export class ErroValidacao extends ErroDominio {
  readonly codigo = 'VALIDACAO';
}

/** Dados válidos, mas a operação viola uma regra de negócio. */
export class ErroRegraNegocio extends ErroDominio {
  readonly codigo = 'REGRA_NEGOCIO';
}

export class ErroNaoEncontrado extends ErroDominio {
  readonly codigo = 'NAO_ENCONTRADO';

  constructor(entidade: string, id: string) {
    super(`${entidade} '${id}' não encontrado(a)`);
  }
}

/** Unicidade violada ou conflito de versão (concorrência otimista). */
export class ErroConflito extends ErroDominio {
  readonly codigo = 'CONFLITO';
}

export class ErroNaoAutenticado extends ErroDominio {
  readonly codigo = 'NAO_AUTENTICADO';
}

export class ErroSemPermissao extends ErroDominio {
  readonly codigo = 'SEM_PERMISSAO';
}

export function conflitoDeVersao(entidade: string, id: string): ErroConflito {
  return new ErroConflito(
    `${entidade} '${id}' foi alterado(a) por outra requisição. Recarregue os dados e tente novamente.`,
  );
}
