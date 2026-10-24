import { PapelUsuario } from '../generated/prisma/enums.js';
import { ErroNaoAutenticado, ErroSemPermissao } from './erros.js';

/**
 * Quem está executando a operação. A camada HTTP monta o Ator a partir do JWT;
 * um futuro consumidor de fila montaria a partir da mensagem. Os serviços só
 * conhecem o Ator - por isso as regras de autorização ficam no serviço e valem
 * para qualquer interface (HTTP, CLI, mensageria).
 */
export interface Ator {
  id: string;
  usuario: string;
  papel: PapelUsuario;
}

const TODOS = Object.values(PapelUsuario);
const { ADMINISTRADOR, OPERADOR_CADASTRO, GESTOR_ALMOXARIFADO, AUDITOR } = PapelUsuario;

/** Segregação de responsabilidades definida na Atividade 1. */
export const PERMISSOES = {
  'usuario:gerenciar': [ADMINISTRADOR],
  'organizacao:ler': TODOS,
  'organizacao:escrever': [ADMINISTRADOR, OPERADOR_CADASTRO],
  'lote:ler': TODOS,
  'lote:escrever': [ADMINISTRADOR, GESTOR_ALMOXARIFADO],
  'equipamento:ler': TODOS,
  'equipamento:escrever': [ADMINISTRADOR, GESTOR_ALMOXARIFADO],
  'relatorio:gerar': [ADMINISTRADOR, AUDITOR],
  'auditoria:ler': [ADMINISTRADOR, AUDITOR],
} as const satisfies Record<string, readonly PapelUsuario[]>;

export type Permissao = keyof typeof PERMISSOES;

export function possuiPermissao(papel: PapelUsuario, permissao: Permissao): boolean {
  return (PERMISSOES[permissao] as readonly PapelUsuario[]).includes(papel);
}

export function exigirPermissao(ator: Ator | undefined, permissao: Permissao): asserts ator is Ator {
  if (!ator) throw new ErroNaoAutenticado('Autenticação necessária');
  if (!possuiPermissao(ator.papel, permissao)) {
    throw new ErroSemPermissao(`O papel ${ator.papel} não possui a permissão '${permissao}'`);
  }
}

/** Ator técnico usado pelo seed e por rotinas internas. */
export const ATOR_SISTEMA: Ator = {
  id: '00000000-0000-0000-0000-000000000000',
  usuario: 'sistema',
  papel: PapelUsuario.ADMINISTRADOR,
};
